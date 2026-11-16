'use strict';

const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {Pool} = require('pg');
const legacy = require('../database/seeds/demo.json');
const {MENU_LOCK, KEY, STATIONS, positiveInt, nonnegativeInt, MAX_INT, transaction} = require('./db');

const defaultFixture = join(__dirname, '../database/seeds/buckhead.json');
const text = (value, limit) => typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= limit;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const validDate = value => typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

function assert(valid, message) {
  if (!valid) throw new Error('Invalid Buckhead fixture: ' + message);
}

function validSource(source) {
  return record(source) && text(source.url, 500) && URL.canParse(source.url)
    && new URL(source.url).protocol === 'https:' && text(source.channel, 100) && validDate(source.checkedOn);
}

function validateDeltas(deltas, ids, label, signed = false) {
  assert(record(deltas), label + ' needs an ingredient map');
  for (const [id, quantity] of Object.entries(deltas)) {
    assert(ids.has(Number(id)) && String(Number(id)) === id, label + ' has an unknown ingredient');
    assert(positiveInt(quantity) || signed && positiveInt(-quantity), label + ' has an invalid quantity');
  }
}

function validateGroups(item, ids) {
  const groups = item.modifierGroups ?? [];
  assert(Array.isArray(groups) && groups.length <= 16, item.key + ' has invalid modifier groups');
  const optionKeys = new Set();
  const groupKeys = new Set();
  const minimumRecipe = {...item.recipe};
  for (const group of groups) {
    assert(record(group) && KEY.test(group.key ?? '') && !groupKeys.has(group.key) && text(group.label, 80),
      item.key + ' has an invalid or duplicate group');
    groupKeys.add(group.key);
    assert(Array.isArray(group.options) && group.options.length <= 32
      && nonnegativeInt(group.min) && positiveInt(group.max)
      && group.min <= group.max && group.max <= group.options.length, group.key + ' has invalid selection limits');
    let defaultCount = 0;
    const groupReductions = new Map();
    for (const option of group.options) {
      assert(record(option) && KEY.test(option.key ?? '') && !optionKeys.has(option.key)
        && text(option.label, 100), group.key + ' has an invalid or duplicate option');
      assert(Number.isInteger(option.priceDeltaCents) && Math.abs(option.priceDeltaCents) <= MAX_INT
        && (option.demo === undefined || typeof option.demo === 'boolean')
        && (option.default === undefined || typeof option.default === 'boolean')
        && (option.instruction === undefined || text(option.instruction, 160)), option.key + ' has invalid details');
      optionKeys.add(option.key);
      if (option.default) defaultCount += 1;
      validateDeltas(option.ingredientDeltas, ids, option.key, true);
      for (const [id, delta] of Object.entries(option.ingredientDeltas).filter(([, amount]) => amount < 0)) {
        if (!groupReductions.has(id)) groupReductions.set(id, []);
        groupReductions.get(id).push(delta);
      }
    }
    assert(defaultCount <= group.max, group.key + ' has too many defaults');
    for (const [id, deltas] of groupReductions) {
      minimumRecipe[id] = (minimumRecipe[id] || 0)
        + deltas.sort((a, b) => a - b).slice(0, group.max).reduce((sum, delta) => sum + delta, 0);
    }
  }
  assert(Object.values(minimumRecipe).every(amount => amount >= 0), item.key + ' can deduct a negative recipe quantity');
}

function validateFixture(fixture) {
  assert(record(fixture) && fixture.schemaVersion === 1 && text(fixture.restaurant, 100)
    && text(fixture.pickupAddress, 240), 'missing restaurant metadata');
  assert(validSource(fixture.priceSource), 'invalid price provenance');
  assert(Array.isArray(fixture.ingredients) && fixture.ingredients.length > 0
    && Array.isArray(fixture.items) && fixture.items.length > 0, 'empty catalog or ingredients');
  const ingredientIds = new Set();
  const ingredientNames = new Set();
  for (const ingredient of fixture.ingredients) {
    assert(record(ingredient) && positiveInt(ingredient.id) && !ingredientIds.has(ingredient.id)
      && text(ingredient.name, 100) && !ingredientNames.has(ingredient.name)
      && text(ingredient.unit, 20) && nonnegativeInt(ingredient.stock) && nonnegativeInt(ingredient.low)
      && (ingredient.standardUnitCostMillicents === null || nonnegativeInt(ingredient.standardUnitCostMillicents)),
    'invalid or duplicate ingredient');
    ingredientIds.add(ingredient.id);
    ingredientNames.add(ingredient.name);
  }
  const keys = new Set();
  const ids = new Set();
  const names = new Set();
  for (const item of fixture.items) {
    assert(record(item) && positiveInt(item.id) && item.id >= 1000 && !ids.has(item.id)
      && KEY.test(item.key ?? '') && !keys.has(item.key) && text(item.name, 120)
      && text(item.category, 60) && STATIONS.includes(item.station) && item.station !== 'legacy'
      && text(item.description, 200) && (item.portion === undefined || text(item.portion, 80)),
    'invalid or duplicate menu item');
    assert(item.priceSource === undefined || validSource(item.priceSource), item.key + ' has invalid price provenance');
    const displayKey = JSON.stringify([item.name.toLowerCase(), item.portion?.toLowerCase() ?? '']);
    assert(!names.has(displayKey), item.key + ' duplicates a menu listing');
    ids.add(item.id);
    keys.add(item.key);
    names.add(displayKey);
    if (item.unavailableReason !== undefined) {
      assert(text(item.unavailableReason, 240) && (item.priceCents === null || nonnegativeInt(item.priceCents))
        && item.recipe === undefined && item.modifierGroups === undefined, item.key + ' has invalid unavailable details');
    } else {
      assert(nonnegativeInt(item.priceCents), item.key + ' has an invalid price');
      validateDeltas(item.recipe, ingredientIds, item.key);
      assert(Object.keys(item.recipe).length > 0, item.key + ' needs a recipe');
      validateGroups(item, ingredientIds);
    }
  }
  return fixture;
}

async function importMenu(pool, input) {
  const fixture = validateFixture(input);
  const counts = await transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [MENU_LOCK]);
    const {rows: [database]} = await client.query('SELECT current_database() AS name');
    if (['pos', 'silaut_research'].includes(database.name)) throw new Error('The research catalog is isolated from the Buckhead import.');

    const {rows: unkeyed} = await client.query('SELECT id,name FROM menu_items WHERE menu_key IS NULL');
    const legacyNames = new Map(legacy.items.map(item => [item.id, item.name]));
    if (unkeyed.some(item => legacyNames.get(item.id) !== item.name)) {
      throw new Error('The database contains an unrecognized legacy catalog. No import was applied.');
    }
    for (const ingredient of fixture.ingredients) {
      const {rowCount} = await client.query(`
        INSERT INTO ingredients (id,name,unit,on_hand,low_stock_threshold,unit_cost_millicents,demo_assumption)
        VALUES ($1,$2,$3,$4,$5,$6,true)
        ON CONFLICT(id) DO UPDATE SET
          low_stock_threshold=EXCLUDED.low_stock_threshold,
          unit_cost_millicents=CASE WHEN ingredients.demo_assumption THEN ingredients.unit_cost_millicents
            ELSE coalesce(ingredients.unit_cost_millicents,EXCLUDED.unit_cost_millicents) END,
          demo_assumption=true
        WHERE (ingredients.name,ingredients.unit)=(EXCLUDED.name,EXCLUDED.unit)
      `, [ingredient.id, ingredient.name, ingredient.unit, ingredient.stock, ingredient.low, ingredient.standardUnitCostMillicents]);
      if (!rowCount) throw new Error('Ingredient identity changed for ID ' + ingredient.id);
    }
    await client.query(`
      INSERT INTO inventory_movements (ingredient_id,delta,unit,balance_after,kind,reason)
      SELECT id,on_hand,unit,on_hand,'opening','Opening balance at Buckhead import'
      FROM ingredients WHERE id=ANY($1::integer[])
      ON CONFLICT (ingredient_id) WHERE kind='opening' DO NOTHING
    `, [fixture.ingredients.map(ingredient => ingredient.id)]);
    for (const item of fixture.items) {
      const source = item.priceSource ?? fixture.priceSource;
      const {rowCount} = await client.query(`
        INSERT INTO menu_items (id,menu_key,name,category,station,price_cents,description,portion,
          unavailable_reason,price_source_url,price_channel,price_checked_on,modifier_groups)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
        ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,category=EXCLUDED.category,station=EXCLUDED.station,
          price_cents=EXCLUDED.price_cents,description=EXCLUDED.description,portion=EXCLUDED.portion,
          unavailable_reason=EXCLUDED.unavailable_reason,price_source_url=EXCLUDED.price_source_url,
          price_channel=EXCLUDED.price_channel,price_checked_on=EXCLUDED.price_checked_on,
          modifier_groups=EXCLUDED.modifier_groups,archived_at=NULL
        WHERE menu_items.menu_key=EXCLUDED.menu_key
      `, [item.id, 'buckhead:' + item.key, item.name, item.category, item.station, item.priceCents ?? 0,
        item.description, item.portion ?? null, item.unavailableReason ?? null, source.url, source.channel,
        source.checkedOn, JSON.stringify(item.modifierGroups ?? [])]);
      if (!rowCount) throw new Error('Menu identity changed for ID ' + item.id);
      await client.query('DELETE FROM recipe_ingredients WHERE menu_item_id=$1', [item.id]);
      await client.query('DELETE FROM menu_modifier_ingredients WHERE menu_item_id=$1', [item.id]);
      const recipe = Object.entries(item.recipe ?? {});
      if (recipe.length) {
        await client.query(`
          INSERT INTO recipe_ingredients (menu_item_id,ingredient_id,units_per_item)
          SELECT $1,ingredient,amount FROM unnest($2::int[],$3::int[]) AS part(ingredient,amount)
        `, [item.id, recipe.map(([id]) => Number(id)), recipe.map(([, quantity]) => quantity)]);
      }
      const modifierIds = [...new Set((item.modifierGroups ?? []).flatMap(group =>
        group.options.flatMap(option => Object.keys(option.ingredientDeltas).map(Number))))];
      if (modifierIds.length) {
        await client.query(`
          INSERT INTO menu_modifier_ingredients (menu_item_id,ingredient_id)
          SELECT $1,ingredient FROM unnest($2::int[]) AS part(ingredient)
        `, [item.id, modifierIds]);
      }
    }
    const {rowCount: archived} = await client.query(`
      UPDATE menu_items SET archived_at=clock_timestamp()
      WHERE archived_at IS NULL AND (menu_key IS NULL OR menu_key LIKE 'buckhead:%' AND id<>ALL($1::integer[]))
    `, [fixture.items.map(item => item.id)]);
    return {archived};
  });
  const categories = {};
  for (const item of fixture.items) {
    const counts = categories[item.category] ??= {sellable: 0, unavailable: 0};
    if (item.unavailableReason) counts.unavailable += 1;
    else counts.sellable += 1;
  }
  return {...counts, priceSource: fixture.priceSource, categories};
}

async function main() {
  const [arg, extra] = process.argv.slice(2);
  if (extra) throw new Error('Usage: node backend/import-menu.js [fixture.json | --check]');
  const fixture = validateFixture(JSON.parse(readFileSync(arg && arg !== '--check' ? arg : defaultFixture, 'utf8')));
  if (arg === '--check') {
    console.log('Validated Buckhead fixture: ' + fixture.items.length + ' entries.');
    return;
  }
  const pool = new Pool();
  try { console.log(JSON.stringify(await importMenu(pool, fixture), null, 2)); }
  finally { await pool.end(); }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = {importMenu, validateFixture};
