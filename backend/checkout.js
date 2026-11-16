'use strict';

const {
  MENU_LOCK, SHIFT_LOCK, UUID, KEY, positiveInt, nonnegativeInt, failure, transaction, lockRequest, lockInventory,
} = require('./db');
const {recordMovement} = require('./inventory');
const {readProfile, receiptIdentity} = require('./profile');

function mergeLines(rows) {
  const merged = new Map();
  for (const row of rows) {
    const key = row.itemId + ':' + (row.modifiers?.join(',') ?? '?');
    const prior = merged.get(key);
    const quantity = (prior?.quantity ?? 0) + row.quantity;
    if (!positiveInt(quantity)) return null;
    merged.set(key, {...row, quantity});
  }
  return [...merged.values()].sort((a, b) => {
    const left = a.modifiers?.join(',') ?? '';
    const right = b.modifiers?.join(',') ?? '';
    return a.itemId - b.itemId || (left < right ? -1 : Number(left > right));
  });
}

function normalizeOrder(body) {
  if (!body || typeof body.orderId !== 'string' || !UUID.test(body.orderId)) return null;
  const multi = Object.hasOwn(body, 'items');
  if (multi && (Object.hasOwn(body, 'itemId') || Object.hasOwn(body, 'quantity') || Object.hasOwn(body, 'modifiers'))) return null;
  const input = multi ? body.items : [body];
  if (!Array.isArray(input) || input.length < 1 || input.length > 100) return null;
  const rows = [];
  for (const line of input) {
    if (!line || !positiveInt(line.itemId) || !positiveInt(line.quantity)) return null;
    const row = {itemId: line.itemId, quantity: line.quantity};
    if (Object.hasOwn(line, 'modifiers')) {
      if (!Array.isArray(line.modifiers) || line.modifiers.length > 128
        || line.modifiers.some(key => typeof key !== 'string' || !KEY.test(key))
        || new Set(line.modifiers).size !== line.modifiers.length) return null;
      row.modifiers = [...line.modifiers].sort();
    }
    rows.push(row);
  }
  const items = mergeLines(rows);
  return items ? {orderId: body.orderId.toLowerCase(), items} : null;
}

function canonicalCart(items, defaults) {
  return mergeLines(items.map(({itemId, quantity, modifiers}) => {
    const selected = modifiers ?? defaults[itemId] ?? [];
    return {itemId, quantity, ...(selected.length ? {modifiers: selected} : {})};
  }));
}

function calculateLine(item, menu, baseRecipe, lineNo) {
  const selected = item.modifiers ?? [];
  const recipe = {...baseRecipe};
  const modifiers = [];
  let charge = menu.price_cents;
  for (const group of menu.modifier_groups) {
    const options = group.options.filter(option => selected.includes(option.key));
    if (options.length < group.min || options.length > group.max) return null;
    for (const option of options) {
      const {key, label, priceDeltaCents, instruction, demo} = option;
      modifiers.push({key, label, priceDeltaCents, ...(instruction && {instruction}), ...(demo && {demo})});
      charge += priceDeltaCents;
      for (const [id, delta] of Object.entries(option.ingredientDeltas)) recipe[id] = (recipe[id] ?? 0) + delta;
    }
  }
  if (modifiers.length !== selected.length || !nonnegativeInt(charge)
    || Object.values(recipe).some(quantity => !Number.isSafeInteger(quantity) || quantity < 0)) return null;
  const lineTotalCents = charge * item.quantity;
  if (!Number.isSafeInteger(lineTotalCents)) return null;
  return {lineNo, itemId: item.itemId, name: menu.name, station: menu.station, quantity: item.quantity,
    baseUnitPriceCents: menu.price_cents, unitPriceCents: charge, lineTotalCents, modifiers, recipe};
}

async function createOrder(pool, {orderId, items}) {
  return transaction(pool, async client => {
    // Serialize retries before reading a live catalog that may have changed since checkout.
    await lockRequest(client, 'order', orderId);
    const {rows: [prior]} = await client.query('SELECT receipt,modifier_defaults FROM orders WHERE id=$1', [orderId]);
    if (prior) {
      const canonical = canonicalCart(items, prior.modifier_defaults);
      const {rows: [comparison]} = await client.query(
        'SELECT cart_json=$2::jsonb AS matches FROM orders WHERE id=$1', [orderId, JSON.stringify(canonical)]);
      return comparison.matches ? {status: 200, body: prior.receipt} : failure(409, 'ORDER_ID_CONFLICT');
    }

    await client.query('SELECT pg_advisory_xact_lock_shared($1)', [MENU_LOCK]);
    await client.query('SELECT pg_advisory_xact_lock_shared($1)', [SHIFT_LOCK]);
    const ids = [...new Set(items.map(item => item.itemId))];
    const {rows: menuRows} = await client.query(`
      SELECT id,name,price_cents,station,modifier_groups,unavailable_reason
      FROM menu_items WHERE id=ANY($1::int[]) AND archived_at IS NULL
    `, [ids]);
    if (menuRows.length !== ids.length) return failure(404, 'ITEM_NOT_FOUND');
    if (menuRows.some(item => item.unavailable_reason)) return failure(409, 'ITEM_UNAVAILABLE');
    const menus = new Map(menuRows.map(menu => [menu.id, menu]));
    const defaults = Object.fromEntries(menuRows.map(menu => [menu.id, menu.modifier_groups.flatMap(group =>
      group.options.filter(option => option.default).map(option => option.key)).sort()]));
    const canonical = canonicalCart(items, defaults);
    if (!canonical) return failure(400, 'INVALID_ORDER');

    const {rows: recipes} = await client.query(`
      SELECT menu_item_id,json_object_agg(ingredient_id,units_per_item) AS amounts
      FROM recipe_ingredients WHERE menu_item_id=ANY($1::integer[]) GROUP BY menu_item_id
    `, [ids]);
    if (recipes.length !== ids.length) return failure(404, 'RECIPE_NOT_FOUND');
    const recipeByItem = new Map(recipes.map(recipe => [recipe.menu_item_id, recipe.amounts]));
    const calculated = canonical.map((item, i) =>
      calculateLine(item, menus.get(item.itemId), recipeByItem.get(item.itemId), i + 1));
    if (calculated.some(line => line === null)) return failure(400, 'INVALID_MODIFIERS');
    const totalCents = calculated.reduce((total, line) => total + line.lineTotalCents, 0);
    if (!Number.isSafeInteger(totalCents)) return failure(400, 'INVALID_ORDER');

    const demand = new Map();
    for (const line of calculated) {
      for (const [id, amount] of Object.entries(line.recipe)) {
        if (amount === 0) continue;
        const ingredientId = Number(id);
        const quantity = (demand.get(ingredientId) ?? 0) + amount * line.quantity;
        if (!Number.isSafeInteger(quantity)) return failure(400, 'INVALID_ORDER');
        demand.set(ingredientId, quantity);
      }
    }
    // Manual adjustments take the same row locks. PostgreSQL rechecks the locked balance.
    const ingredients = await lockInventory(client, [...demand.keys()]);
    if (ingredients.length !== demand.size) return failure(404, 'RECIPE_NOT_FOUND');
    const shortages = ingredients.filter(ingredient => ingredient.on_hand < demand.get(ingredient.id)).map(ingredient => ({
      ingredientId: ingredient.id, name: ingredient.name, unit: ingredient.unit, onHand: ingredient.on_hand,
      required: demand.get(ingredient.id),
      itemIds: [...new Set(calculated.filter(line => line.recipe[ingredient.id] > 0).map(line => line.itemId))],
    }));
    if (shortages.length) return failure(409, 'INSUFFICIENT_INVENTORY', {shortages});

    const costComplete = ingredients.every(ingredient => ingredient.unit_cost_millicents !== null);
    const cost = costComplete ? ingredients.reduce((total, ingredient) =>
      total + BigInt(ingredient.unit_cost_millicents) * BigInt(demand.get(ingredient.id)), 0n).toString() : null;
    const profile = await readProfile(client);
    const first = calculated[0];
    const {rows: [order]} = await client.query(`
      WITH stamp AS (SELECT clock_timestamp() AS time)
      INSERT INTO orders (id,menu_item_id,quantity,unit_price_cents,cart_json,modifier_defaults,
        total_cents,food_cost_millicents,created_at,status_updated_at,business_date,shift_id)
      SELECT $1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,time,time,silaut_business_day(time,$9),
        (SELECT id FROM shifts WHERE closed_at IS NULL) FROM stamp
      RETURNING ticket_no,created_at,shift_id
    `, [orderId, first.itemId, first.quantity, first.unitPriceCents, JSON.stringify(canonical),
      JSON.stringify(defaults), totalCents, cost, profile.cutoffMinutes]);

    const stations = [...new Set(calculated.map(line => line.station))];
    await client.query(`
      INSERT INTO ticket_stations (order_id,station,status_updated_at)
      SELECT $1,station,$3 FROM unnest($2::text[]) AS station
    `, [orderId, stations, order.created_at]);
    const lines = [];
    for (const {recipe, ...line} of calculated) {
      await client.query(`
        INSERT INTO order_items (order_id,line_no,menu_item_id,item_name,quantity,unit_price_cents,
          base_unit_price_cents,station,modifiers)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
      `, [orderId, line.lineNo, line.itemId, line.name, line.quantity, line.unitPriceCents,
        line.baseUnitPriceCents, line.station, JSON.stringify(line.modifiers)]);
      lines.push(line);
    }
    for (const ingredient of ingredients) {
      await recordMovement(client, ingredient, {
        kind: 'sale', delta: -demand.get(ingredient.id), orderId, shiftId: order.shift_id,
      });
    }
    const {rows: [snapshot]} = await client.query(`
      SELECT SUM(i.revision)::text AS version,MIN(i.on_hand/r.units_per_item)::integer AS units
      FROM recipe_ingredients r JOIN ingredients i ON i.id=r.ingredient_id WHERE r.menu_item_id=$1
    `, [first.itemId]);
    const receipt = {
      orderId, ticketNumber: Number(order.ticket_no), createdAt: order.created_at.toISOString(),
      items: lines, totalCents, currency: 'USD', paymentMode: 'simulated', restaurant: receiptIdentity(profile),
      ...(lines.length === 1 && {itemId: first.itemId, quantity: first.quantity, unitPriceCents: first.unitPriceCents,
        stockVersionAfter: snapshot.version, sellableUnitsAfter: snapshot.units}),
    };
    await client.query('UPDATE orders SET stock_version_after=$2,sellable_units_after=$3,receipt=$4::jsonb WHERE id=$1',
      [orderId, snapshot.version, snapshot.units, JSON.stringify(receipt)]);
    return {status: 201, body: receipt, ingredients: ingredients.map(ingredient => ingredient.id)};
  });
}

module.exports = {normalizeOrder, createOrder, positiveInt};
