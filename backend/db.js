'use strict';

const MENU_LOCK = 7319052;
const SHIFT_LOCK = 7319053;
const MAX_INT = 2147483647;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[a-z][a-z0-9-]{0,63}$/;
const STATIONS = ['grill', 'fryer', 'pasta', 'drinks', 'prep', 'legacy'];
const positiveInt = value => Number.isInteger(value) && value > 0 && value <= MAX_INT;
const nonnegativeInt = value => Number.isInteger(value) && value >= 0 && value <= MAX_INT;
const failure = (status, code, extra = {}) => ({status, body: {code, ...extra}});

async function transaction(pool, work) {
  const client = await pool.connect();
  let broken;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) { broken = rollbackError; }
    throw error;
  } finally {
    client.release(broken);
  }
}

function lockRequest(client, scope, id) {
  return client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [scope + ':' + id]);
}

function lockInventory(client, ids) {
  return client.query(`
    SELECT id, name, unit, on_hand, revision::text, unit_cost_millicents
    FROM ingredients WHERE id = ANY($1::integer[]) ORDER BY id FOR UPDATE
  `, [ids]).then(result => result.rows);
}

module.exports = {
  MENU_LOCK, SHIFT_LOCK, MAX_INT, UUID, KEY, STATIONS, positiveInt, nonnegativeInt,
  failure, transaction, lockRequest, lockInventory,
};
