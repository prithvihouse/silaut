'use strict';

const {test, before, beforeEach, after} = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {once} = require('node:events');
const {spawn} = require('node:child_process');
const {setTimeout: wait} = require('node:timers/promises');
const {Pool} = require('pg');
const {createClient} = require('redis');
const sharp = require('sharp');
const {importMenu, validateFixture} = require('../backend/import-menu');
const {insertDemo} = require('../backend/seed');
const fixture = require('../database/seeds/buckhead.json');

if (process.env.PGDATABASE !== 'silaut_test' || process.env.SILAUT_ALLOW_TEST_RESET !== '1') {
  throw new Error('V2 tests require PGDATABASE=silaut_test and SILAUT_ALLOW_TEST_RESET=1.');
}

const pool = new Pool();
const redis = createClient({url: process.env.REDIS_URL});
const port = Number(process.env.SILAUT_TEST_PORT || 3311);
const burger = 1001;
const fries = 1040;
const wings = 1030;
const combo = [{itemId: burger, quantity: 1, modifiers: ['extra-patty', 'no-cheese', 'sauce-side']}, {itemId: fries, quantity: 1}];
let server;

async function request(route, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch('http://127.0.0.1:' + port + '/api' + route, {
    method, headers: {'Content-Type': 'application/json'},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    signal: AbortSignal.timeout(10000),
  });
  const type = response.headers.get('content-type');
  const result = type?.includes('json') ? await response.json() : await response.arrayBuffer();
  return {status: response.status, body: result, type};
}

async function start() {
  server = spawn(process.execPath, ['backend/server.js'], {
    env: {...process.env, PORT: String(port), BIND_HOST: '127.0.0.1', CACHE_MODE: 'ttl-fenced', CACHE_TTL_SECONDS: '25',
      PGUSER: process.env.SILAUT_TEST_APP_USER || process.env.PGUSER,
      PGPASSWORD: process.env.SILAUT_TEST_APP_PASSWORD || process.env.PGPASSWORD},
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let tries = 0; tries < 80; tries++) {
    if (server.exitCode !== null) throw new Error('Verification API exited.');
    try { if ((await request('/healthz')).status === 200) return; } catch { /* Process is starting. */ }
    await wait(100);
  }
  throw new Error('Verification API did not become ready.');
}

async function stop() {
  if (server && server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill('SIGTERM');
    await exited;
  }
}

async function rows(sql, values) {
  return (await pool.query(sql, values)).rows;
}
const stock = async () => Object.fromEntries((await rows('SELECT id,on_hand FROM ingredients')).map(i => [i.id, i.on_hand]));
const sales = date => request('/sales/daily' + (date ? '?date=' + date : ''));
const order = (items, orderId = randomUUID()) => request('/orders', {orderId, items});
const move = (id, input) => request('/inventory/ingredients/' + id + '/movements', input);
const step = (id, station, expectedStatus, status) =>
  request('/tickets/' + id + '/status', {station, expectedStatus, status}, 'PATCH');

before(async () => { await redis.connect(); await start(); });
beforeEach(async () => {
  await pool.query('TRUNCATE order_items,orders,shifts,recipe_ingredients,menu_items,ingredients,app_settings RESTART IDENTITY CASCADE');
  await pool.query(`UPDATE restaurant_profile SET name='Bite More',location_label='Buckhead · Atlanta, GA',
    address='3150 Roswell Rd NW, Suite A1, Atlanta, GA 30305',logo_digest=NULL,cutoff_minutes=240`);
  await pool.query('DELETE FROM restaurant_logos');
  await redis.flushDb();
  await importMenu(pool, fixture);
});
after(async () => { await stop(); if (redis.isOpen) await redis.quit(); await pool.end(); });

test('validates bounded raster profile, survives restart and snapshots the original identity on receipts', async () => {
  const updated = {name: 'Bite More Test', locationLabel: 'Bakery counter', address: '1 Demo Street', cutoffMinutes: 255};
  const denied = await request('/settings/profile', {...updated, logo: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}, 'PUT');
  assert.deepEqual([denied.status, denied.body.code], [400, 'INVALID_LOGO']);
  assert.equal((await request('/profile')).body.name, 'Bite More');
  const oversized = await sharp({create: {width: 1025, height: 1, channels: 3, background: '#115647'}}).png().toBuffer();
  assert.equal((await request('/settings/profile', {...updated, logo: oversized.toString('base64')}, 'PUT')).status, 400);
  const png = await sharp({create: {width: 16, height: 16, channels: 3, background: '#115647'}}).png().toBuffer();
  const result = await request('/settings/profile', {...updated, logo: png.toString('base64')}, 'PUT');
  assert.equal(result.status, 200);
  assert.match(result.body.logoUrl, /^\/api\/logos\/[0-9a-f]{64}$/);
  await stop();
  await start();
  assert.deepEqual((await request('/profile')).body, result.body);
  const logo = await request(result.body.logoUrl.slice(4));
  assert.equal(logo.type, 'image/png');
  assert.equal((await sharp(Buffer.from(logo.body)).metadata()).width, 16);
  const purchased = await order([{itemId: fries, quantity: 1}]);
  assert.equal(purchased.status, 201);
  assert.deepEqual(purchased.body.restaurant, {
    name: updated.name, locationLabel: updated.locationLabel, address: updated.address, logoUrl: result.body.logoUrl,
  });
  assert.equal((await request('/settings/profile', {...updated, name: 'Changed later', logo: null}, 'PUT')).status, 200);
  assert.equal((await request('/profile')).body.logoUrl, null);
  const old = await request('/orders/' + purchased.body.orderId);
  assert.deepEqual(old.body.restaurant, purchased.body.restaurant);
  assert.equal((await request(result.body.logoUrl.slice(4))).status, 200);
});

test('verified prices and modifiers deduct exact stock and route one ticket to Grill and Fryer', async () => {
  const catalog = (await request('/catalog')).body.items;
  assert.equal(catalog.find(item => item.itemId === burger).priceCents, 1499);
  assert.equal(catalog.find(item => item.itemId === fries).priceCents, 499);
  assert.equal(catalog.length, 46);
  assert.ok(catalog.every(item => item.category !== 'Salads'));
  const alfredo = catalog.find(item => item.itemId === 1010);
  const cajun = catalog.find(item => item.itemId === 1012);
  assert.equal(cajun.priceCents, alfredo.priceCents);
  assert.equal(cajun.priceChannel, 'Owner-confirmed demo price');
  assert.deepEqual(cajun.modifierGroups, alfredo.modifierGroups);
  assert.equal((await order([{itemId: 1101, quantity: 1}])).body.code, 'ITEM_NOT_FOUND');
  const starting = await stock();
  const sale = await order(combo);
  assert.equal(sale.status, 201);
  assert.equal(sale.body.totalCents, 2297);
  assert.deepEqual(sale.body.items.map(item => [item.baseUnitPriceCents, item.unitPriceCents]), [[1499, 1798], [499, 499]]);
  assert.equal(sale.body.items[0].modifiers.find(option => option.key === 'extra-patty').priceDeltaCents, 299);
  const orderId = sale.body.orderId;
  const deductions = {1: 3, 6: 200, 7: 2, 14: 1, 15: 25, 16: 35, 45: 6};
  const ending = await stock();
  for (const id of Object.keys(starting)) assert.equal(starting[id] - ending[id], deductions[id] ?? 0, 'ingredient ' + id);
  const ledger = await rows(`
    SELECT ingredient_id,delta,balance_after,standard_unit_cost_millicents
    FROM inventory_movements WHERE order_id=$1 ORDER BY ingredient_id
  `, [orderId]);
  assert.deepEqual(Object.fromEntries(ledger.map(item => [item.ingredient_id, -item.delta])), deductions);
  assert.ok(ledger.every(row => row.balance_after === ending[row.ingredient_id] && row.standard_unit_cost_millicents !== null));

  const [all, grill, fryer] = await Promise.all(['', '?station=grill', '?station=fryer'].map(query => request('/tickets' + query)));
  assert.equal(all.body.tickets.length, 1);
  assert.equal(grill.body.tickets[0].ticketNumber, fryer.body.tickets[0].ticketNumber);
  assert.deepEqual(grill.body.tickets[0].items.map(item => item.itemId), [burger]);
  assert.deepEqual(fryer.body.tickets[0].items.map(item => item.itemId), [fries]);
  assert.ok(grill.body.tickets[0].items[0].modifiers.some(option => option.label === 'No cheese'));

  const prepare = await Promise.all(['grill', 'fryer'].map(station => step(orderId, station, 'new', 'preparing')));
  assert.ok(prepare.every(result => result.status === 200));
  assert.equal((await step(orderId, 'grill', 'preparing', 'ready')).body.orderStatus, 'preparing');
  assert.equal((await step(orderId, 'grill', 'preparing', 'ready')).body.orderStatus, 'preparing');
  assert.equal((await request('/orders/' + orderId)).body.readyAt, null);
  await stop();
  await start();
  assert.equal((await request('/tickets?station=grill')).body.tickets[0].status, 'ready');
  assert.equal((await step(orderId, 'fryer', 'preparing', 'ready')).body.orderStatus, 'ready');
  const ready = (await request('/orders/' + orderId)).body;
  assert.equal(ready.kitchenStatus, 'ready');
  const readyTimes = await rows('SELECT ready_at AS "readyAt" FROM ticket_stations WHERE order_id=$1 ORDER BY ready_at DESC', [orderId]);
  assert.equal(ready.readyAt, readyTimes[0].readyAt.toISOString());
  assert.notEqual((await sales()).body.averageReadySeconds, null);
});

test('equivalent modifiers and default choices replay, conflicts never mutate, and separate configurations stay separate', async () => {
  const id = randomUUID();
  const variants = [
    {itemId: burger, quantity: 1, modifiers: ['extra-patty', 'no-cheese']},
    {itemId: burger, quantity: 1, modifiers: []},
    {itemId: burger, quantity: 1, modifiers: ['no-cheese', 'extra-patty']},
    {itemId: wings, quantity: 1},
  ];
  const sale = await order(variants, id);
  assert.equal(sale.status, 201);
  const lines = sale.body.items.filter(item => item.itemId === burger);
  assert.deepEqual(lines.map(line => line.quantity), [1, 2]);
  assert.notEqual(lines[0].lineNo, lines[1].lineNo);
  const preReplay = await stock();
  const alternate = [
    {itemId: wings, quantity: 1, modifiers: ['plain']}, variants[1],
    {itemId: burger, quantity: 2, modifiers: ['no-cheese', 'extra-patty']},
  ];
  const results = await Promise.all(Array.from({length: 4}, () => order(alternate, id)));
  assert.ok(results.every(result => result.status === 200));
  for (const result of results) assert.deepEqual(result.body, sale.body);
  alternate[1] = {...alternate[1], modifiers: ['sauce-side']};
  assert.equal((await order(alternate, id)).body.code, 'ORDER_ID_CONFLICT');
  assert.equal((await order([{itemId: wings, quantity: 1, modifiers: []}])).body.code, 'INVALID_MODIFIERS');
  assert.equal((await order([{itemId: burger, quantity: 1, modifiers: ['side-fries', 'side-garlic-fries']}])).status, 400);
  assert.deepEqual(await stock(), preReplay);
  assert.equal((await rows('SELECT count(*)::int AS count FROM orders'))[0].count, 1);
  const ledger = await rows('SELECT ingredient_id,count(*)::int AS count FROM inventory_movements WHERE order_id=$1 GROUP BY ingredient_id', [id]);
  assert.ok(ledger.length > 0 && ledger.every(line => line.count === 1));

  await Promise.all(['grill', 'fryer'].map(station => step(id, station, 'new', 'preparing')));
  const finish = await Promise.all(['grill', 'fryer'].map(station => step(id, station, 'preparing', 'ready')));
  assert.deepEqual(finish.map(result => result.body.orderStatus).sort(), ['preparing', 'ready']);
  assert.equal((await request('/orders/' + id)).body.kitchenStatus, 'ready');
});

test('last-stock checkout and shared ingredient shortage remain atomic with modifiers', async () => {
  await pool.query('UPDATE ingredients SET on_hand=4 WHERE id=1');
  const initial = await stock();
  const shortage = await order([...combo, {itemId: burger, quantity: 1}]);
  assert.equal(shortage.status, 409);
  assert.deepEqual(shortage.body.shortages.map(item => [item.ingredientId, item.required]), [[1, 5]]);
  assert.deepEqual(await stock(), initial);
  assert.equal((await rows("SELECT count(*)::int AS n FROM inventory_movements WHERE kind='sale'"))[0].n, 0);

  await pool.query('UPDATE ingredients SET on_hand=3 WHERE id=1');
  const outcomes = await Promise.all([order(combo), order(combo)]);
  assert.deepEqual(outcomes.map(outcome => outcome.status).sort(), [201, 409]);
  assert.equal((await stock())[1], 0);
  assert.equal((await rows('SELECT count(*)::int AS n FROM orders'))[0].n, 1);
  assert.equal((await rows("SELECT count(*)::int AS n FROM inventory_movements WHERE kind='sale'"))[0].n, 7);
});

test('receiving, waste, count, negative stock, and cache invalidation use retry-safe ledger entries', async () => {
  const receive = {adjustmentId: randomUUID(), kind: 'receive', quantity: 10, reference: 'Delivery 20', purchaseCostCents: 440};
  const posted = await move(1, receive);
  assert.equal(posted.status, 201);
  assert.equal(posted.body.balanceAfter, 58);
  const replay = await move(1, receive);
  assert.deepEqual(replay, {...posted, status: 200});
  assert.equal((await move(1, {...receive, quantity: 11})).body.code, 'ADJUSTMENT_ID_CONFLICT');
  const waste = {adjustmentId: randomUUID(), kind: 'waste', quantity: 2, reason: 'during prep'};
  assert.equal((await move(1, {...waste, reason: '   '})).status, 400);
  assert.equal((await move(1, {...waste, quantity: 70})).body.code, 'NEGATIVE_STOCK');
  assert.equal((await move(1, waste)).body.balanceAfter, 56);
  const count = {adjustmentId: randomUUID(), kind: 'count', quantity: 52, expectedRevision: '2'};
  assert.equal((await move(1, {...count, expectedRevision: '0'})).body.code, 'STOCK_CHANGED');
  assert.equal((await move(1, count)).body.delta, -4);
  assert.equal((await move(1, count)).status, 200);
  const detail = (await request('/inventory/ingredients/1')).body;
  assert.equal(detail.ingredient.onHand, 52);
  assert.deepEqual(detail.movements.map(entry => [entry.kind, entry.delta]), [
    ['count', -4], ['waste', -2], ['receive', 10], ['opening', 48],
  ]);
  assert.equal(detail.movements[1].reason, 'during prep');
  assert.equal(detail.movements[2].purchaseCostCents, 440);

  assert.equal((await request('/menu/items/' + burger)).status, 200);
  assert.equal(await redis.exists('pos:menu:' + burger), 1);
  await move(28, {adjustmentId: randomUUID(), kind: 'receive', quantity: 1});
  assert.equal(await redis.exists('pos:menu:' + burger), 0, 'modifier-only ingredient invalidates the burger');

  await pool.query('UPDATE ingredients SET on_hand=4 WHERE id=1');
  const concurrent = await Promise.all([order(combo), move(1, {adjustmentId: randomUUID(), kind: 'waste', quantity: 2, reason: 'trim'})]);
  assert.deepEqual(concurrent.map(outcome => outcome.status).sort(), [201, 409]);
  assert.ok([1, 2].includes((await stock())[1]));
});

test('daily metrics use Eastern service date, cost coverage, charge snapshots and rounded averages', async () => {
  await pool.query('UPDATE ingredients SET unit_cost_millicents=CASE id WHEN 6 THEN 1000 WHEN 50 THEN NULL ELSE 0 END');
  const covered = await order([{itemId: fries, quantity: 2}]);
  const unknown = await order([{itemId: 1080, quantity: 1}]);
  const isolated = await order([{itemId: fries, quantity: 1}]);
  assert.equal(covered.status, 201);
  const samples = [
    [covered.body.orderId, '2026-11-18T08:59:00Z', 120],
    [unknown.body.orderId, '2026-11-17T22:00:00Z', null],
    [isolated.body.orderId, '2026-11-18T09:01:00Z', 300],
  ];
  for (const [id, stamp, seconds] of samples) {
    await pool.query(`
      UPDATE orders SET created_at=$2::timestamptz,business_date=silaut_business_day($2,240),
        ready_at=$2::timestamptz+make_interval(secs=>$3) WHERE id=$1
    `, [id, stamp, seconds]);
  }
  const prev = await sales('2026-11-17');
  assert.equal(prev.status, 200);
  assert.deepEqual([
    prev.body.salesCents, prev.body.orderCount, prev.body.averageTicketCents, prev.body.readyOrderCount,
    prev.body.averageReadySeconds, prev.body.coveredOrders, prev.body.coveredSalesCents,
    prev.body.coveredFoodCostCents, prev.body.foodCostBasisPoints,
  ], [1297, 2, 649, 1, 120, 1, 998, 400, 4008]);
  assert.equal(prev.body.topByUnits[0].name, 'Peri Peri Fries');
  assert.equal(prev.body.topBySales[0].salesCents, 998);
  assert.equal((await sales('2026-11-18')).body.salesCents, 499);
  const empty = (await sales('2026-11-16')).body;
  assert.deepEqual([empty.salesCents, empty.orderCount, empty.averageTicketCents, empty.foodCostBasisPoints], [0, 0, null, null]);
  await request('/inventory/ingredients/6/cost', {standardUnitCostMillicents: 777}, 'PATCH');
  assert.deepEqual((await sales('2026-11-17')).body, prev.body);
  const dst = await rows(`SELECT silaut_business_day('2026-03-08T07:59Z',240)::text AS before_cutoff,
    silaut_business_day('2026-03-08T08:01Z',240)::text AS after_cutoff,
    silaut_business_day('2026-03-08T08:01Z',300)::text AS later_cutoff`);
  assert.deepEqual(dst[0], {before_cutoff: '2026-03-07', after_cutoff: '2026-03-08', later_cutoff: '2026-03-07'});
  assert.equal((await sales('2026-02-31')).status, 400);
});

test('one open shift, assigned sales, one frozen close report, waste and CSV survive restart', async () => {
  const unassigned = await order([{itemId: 1080, quantity: 1}]);
  assert.equal(unassigned.status, 201);
  const shiftId = randomUUID();
  const open = await request('/shifts/open', {shiftId});
  assert.equal(open.status, 201);
  assert.equal((await request('/shifts/open', {shiftId})).status, 200);
  assert.equal((await request('/shifts/open', {shiftId: randomUUID()})).status, 409);
  const sale = await order(combo);
  assert.equal(sale.status, 201);
  await move(1, {adjustmentId: randomUUID(), kind: 'waste', quantity: 3, reason: 'Shift prep'});
  const closes = await Promise.all([request('/shifts/' + shiftId + '/close', {}), request('/shifts/' + shiftId + '/close', {})]);
  const [first, second] = closes;
  assert.equal(first.status, 200);
  assert.deepEqual(first, second);
  const report = first.body.report;
  assert.deepEqual([report.salesCents, report.orderCount, report.averageTicketCents, report.readyOrderCount], [2297, 1, 2297, 0]);
  assert.deepEqual(report.waste, [{ingredientId: 1, name: 'Beef patty', unit: 'patty', quantity: 3, movements: 1}]);
  const day = await sales();
  assert.equal(day.body.salesCents, 2596);
  await Promise.all(['grill', 'fryer'].map(station => step(sale.body.orderId, station, 'new', 'preparing')));
  await Promise.all(['grill', 'fryer'].map(station => step(sale.body.orderId, station, 'preparing', 'ready')));
  await stop();
  await start();
  const saved = (await request('/shifts')).body;
  assert.equal(saved.active, null);
  assert.deepEqual(saved.recent[0].report, report);
  const exported = await request('/shifts/' + shiftId + '/report.csv');
  assert.match(exported.type, /^text\/csv/);
  assert.match(Buffer.from(exported.body).toString(), /"Estimated food cost \(% of covered sales\)"/);
  assert.match(Buffer.from(exported.body).toString(), /"Beef patty","3","patty","1"/);
});

test('validated reruns archive V1 without rewriting receipts, stock, opening ledger or manual cost edits', async () => {
  await pool.query('TRUNCATE order_items,orders,shifts,recipe_ingredients,menu_items,ingredients,app_settings RESTART IDENTITY CASCADE');
  const client = await pool.connect();
  try { await insertDemo(client); } finally { client.release(); }
  const prior = await order([{itemId: 1, quantity: 1}]);
  assert.equal(prior.status, 201);
  const initial = await stock();
  await importMenu(pool, fixture);
  assert.equal((await request('/menu')).body.some(item => item.itemId === 1), false);
  assert.equal((await order([{itemId: 1, quantity: 1}])).status, 404);
  const replay = await order([{itemId: 1, quantity: 1}], prior.body.orderId);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, prior.body);
  const reopen = await request('/inventory/ingredients/1/cost', {standardUnitCostMillicents: null}, 'PATCH');
  assert.equal(reopen.status, 200);
  const rowsBefore = await rows("SELECT count(*)::int AS n FROM inventory_movements WHERE kind='opening'");
  await importMenu(pool, fixture);
  assert.deepEqual(await rows("SELECT count(*)::int AS n FROM inventory_movements WHERE kind='opening'"), rowsBefore);
  const after = await stock();
  for (const [id, quantity] of Object.entries(initial)) assert.equal(after[id], quantity);
  assert.equal((await request('/inventory/ingredients/1')).body.ingredient.standardUnitCostMillicents, null);
  const invalid = structuredClone(fixture);
  invalid.items[0].modifierGroups[0].options[0].ingredientDeltas['999999'] = 1;
  assert.throws(() => validateFixture(invalid), /unknown ingredient/);
});
