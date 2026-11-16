'use strict';

const assert = require('node:assert/strict');
const {Pool} = require('pg');
const {migrate} = require('../backend/migrate');
const {importMenu} = require('../backend/import-menu');
const fixture = require('../database/seeds/buckhead.json');

if (process.env.PGDATABASE !== 'silaut_upgrade') throw new Error('A dedicated silaut_upgrade database is required.');
const pool = new Pool();

async function snapshot() {
  const [orders, lines, balances, migration] = await Promise.all([
    pool.query(`SELECT id,menu_item_id,quantity,unit_price_cents,ticket_no,total_cents,
      created_at,status,status_updated_at,cart_json,receipt,stock_version_after,sellable_units_after
      FROM orders ORDER BY ticket_no`),
    pool.query('SELECT order_id,menu_item_id,item_name,quantity,unit_price_cents FROM order_items ORDER BY order_id,menu_item_id'),
    pool.query('SELECT id,name,unit,on_hand,revision FROM ingredients WHERE id<14 ORDER BY id'),
    pool.query("SELECT name,sha256 FROM schema_migrations WHERE name<'003' ORDER BY name"),
  ]);
  return {orders: orders.rows, lines: lines.rows, balances: balances.rows, migration: migration.rows};
}

async function main() {
  const {rows: [version]} = await pool.query("SELECT to_regclass('restaurant_profile') AS v2");
  assert.equal(version.v2, null, 'Rehearsal expects a pre-v2 backup.');
  const before = await snapshot();
  assert.equal(before.migration.length, 2);
  await migrate();
  for (let run = 0; run < 2; run++) await importMenu(pool, fixture);
  assert.deepEqual(await snapshot(), before);
  const {rows: [counts]} = await pool.query(`
    SELECT (SELECT count(*)::int FROM menu_items WHERE archived_at IS NOT NULL AND menu_key IS NULL) AS archived,
        (SELECT count(*)::int FROM menu_items WHERE archived_at IS NULL AND unavailable_reason IS NULL) AS sellable,
        (SELECT count(*)::int FROM inventory_movements WHERE kind='opening') AS opening,
        (SELECT count(*)::int FROM inventory_movements WHERE kind='sale') AS historic_sales,
        (SELECT count(*)::int FROM orders WHERE food_cost_millicents IS NOT NULL) AS historic_costs
  `);
  assert.deepEqual(counts, {
    archived: 6, sellable: fixture.items.filter(item => !item.unavailableReason).length,
    opening: fixture.ingredients.length, historic_sales: 0, historic_costs: 0,
  });
  const {rows: boundaries} = await pool.query(`
    SELECT ingredient_id AS id,delta AS on_hand,unit FROM inventory_movements
    WHERE kind='opening' AND ingredient_id<14 ORDER BY ingredient_id
  `);
  assert.deepEqual(boundaries, before.balances.map(({id, on_hand, unit}) => ({id, on_hand, unit})));
  const {rows: history} = await pool.query(`
    SELECT o.ticket_no,o.status,s.station,s.status AS station_status,s.ready_at,o.ready_at AS order_ready_at,
      o.receipt->>'totalCents' AS total_cents
    FROM orders o JOIN ticket_stations s ON s.order_id=o.id ORDER BY o.ticket_no
  `);
  for (const [index, prior] of before.orders.entries()) {
    assert.equal(history[index].station, 'legacy');
    assert.equal(history[index].station_status, prior.status);
    assert.deepEqual(history[index].ready_at, prior.status === 'ready' ? prior.status_updated_at : null);
    assert.deepEqual(history[index].order_ready_at, history[index].ready_at);
  }
  console.log(JSON.stringify({status: 'PASS', priorOrders: before.orders.length,
    priorLines: before.lines.length, priorIngredientBalances: before.balances.length,
    ticket101: history.find(row => row.ticket_no === '101') ?? null, ...counts}, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
