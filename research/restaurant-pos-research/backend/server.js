'use strict';

const express = require('express');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Pool } = require('pg');
const { createClient } = require('redis');
const { refillGate } = require('./refill_gate');

const mode = process.env.CACHE_MODE || 'postgres';
if (!['postgres', 'ttl', 'ttl-invalidate', 'ttl-fenced'].includes(mode)) {
  throw new Error('Unknown CACHE_MODE.');
}
const fenced = mode === 'ttl-fenced';
const fills = fenced ? readFileSync(join(__dirname, 'lua/fill.lua'), 'utf8') : null;
const invalidates = fenced ? readFileSync(join(__dirname, 'lua/invalidate.lua'), 'utf8') : null;
const bindHost = process.env.BIND_HOST || '0.0.0.0';
const testGateEnabled = process.env.POS_TEST_HOOKS === '1';
if (testGateEnabled && bindHost !== '127.0.0.1') throw new Error('Test gate requires a loopback listener.');

function integerSetting(name, fallback, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error('Invalid setting ' + name);
  return value;
}

const ttl = integerSetting('CACHE_TTL_SECONDS', 10, 86400);
const poolMax = integerSetting('PG_POOL_MAX', 10, 100);
const port = integerSetting('PORT', 3000, 65535);
const pool = new Pool({ max: poolMax, connectionTimeoutMillis: 1500, statement_timeout: 2000 });
pool.on('error', (error) => console.error('PostgreSQL idle client:', error.message));

const redis = mode === 'postgres' ? null : createClient({
  url: process.env.REDIS_URL || 'redis://127.0.0.1:6379/0',
  disableOfflineQueue: true,
  socket: {
    connectTimeout: 1000,
    reconnectStrategy: (attempt) => Math.min(50 * (attempt + 1), 500),
  },
});
const metrics = {
  menuDatabaseReads: 0, cacheHits: 0, cacheMisses: 0,
  cacheGetErrors: 0, cacheSetErrors: 0, redisConnectionErrors: 0,
  invalidationAttempts: 0, invalidationErrors: 0, deletedKeys: 0,
  fenceRejectedFills: 0, retainedCacheFills: 0,
};
redis?.on('error', () => { metrics.redisConnectionErrors += 1; });

const app = express();
app.disable('etag');
app.disable('x-powered-by');
app.use(express.json({ limit: '8kb' }));
const itemsByIngredient = new Map();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keyFor = (id) => 'pos:menu:' + id;
const generationFor = (id) => 'pos:generation:' + id;
const positiveInt = (value) => Number.isInteger(value) && value > 0 && value <= 2147483647;
const gate = testGateEnabled ? refillGate(app, positiveInt) : null;
const asyncRoute = (handler) => (request, response, next) =>
  handler(request, response).catch(next);

async function cacheCommand(args) {
  if (!redis.isReady) throw new Error('Redis unavailable');
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Redis deadline exceeded'));
    }, 200);
  });
  try {
    return await Promise.race([redis.sendCommand(args, { signal: controller.signal }), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchItem(id) {
  metrics.menuDatabaseReads += 1;
  const { rows: [item] } = await pool.query(`
    SELECT /* pos_menu_item */ m.id AS "itemId", m.name, m.price_cents AS "priceCents",
           MIN(i.on_hand / r.units_per_item)::integer AS "sellableUnits",
           SUM(i.revision)::text AS "stockVersion"
    FROM menu_items m
    JOIN recipe_ingredients r ON r.menu_item_id = m.id
    JOIN ingredients i ON i.id = r.ingredient_id
    WHERE m.id = $1
    GROUP BY m.id
  `, [id]);
  return item ? { ...item, available: item.sellableUnits > 0 } : null;
}

async function cachedItem(id) {
  const key = keyFor(id);
  let generation;
  if (redis) {
    try {
      let cached;
      if (fenced) {
        [cached, generation] = await cacheCommand(['MGET', key, generationFor(id)]);
      } else {
        cached = await cacheCommand(['GET', key]);
      }
      if (cached !== null) {
        const item = JSON.parse(cached);
        metrics.cacheHits += 1;
        return item;
      }
      metrics.cacheMisses += 1;
    } catch (_) {
      metrics.cacheGetErrors += 1;
    }
  }
  const item = await fetchItem(id);
  if (gate) await gate.afterSnapshot(id);
  if (redis && item && (!fenced || generation !== undefined)) {
    try {
      const body = JSON.stringify(item);
      if (fenced) {
        const stored = await cacheCommand([
          'EVAL', fills, '2', key, generationFor(id),
          generation ?? '0', item.stockVersion, body, String(ttl),
        ]);
        if (stored === 0) metrics.fenceRejectedFills += 1;
        if (stored === 2) metrics.retainedCacheFills += 1;
      } else {
        await cacheCommand(['SET', key, body, 'EX', String(ttl)]);
      }
    } catch (_) {
      metrics.cacheSetErrors += 1;
    }
  }
  return item;
}

async function invalidate(ingredients) {
  const items = new Set();
  for (const ingredient of ingredients) {
    for (const item of itemsByIngredient.get(ingredient)) items.add(item);
  }
  metrics.invalidationAttempts += 1;
  try {
    const keys = Array.from(items, keyFor);
    const command = fenced
      ? ['EVAL', invalidates, String(keys.length * 2), ...keys, ...Array.from(items, generationFor)]
      : ['DEL', ...keys];
    metrics.deletedKeys += await cacheCommand(command);
  } catch (_) {
    metrics.invalidationErrors += 1;
  }
}

const receiptColumns = `
  id AS "orderId", menu_item_id AS "itemId", quantity, unit_price_cents AS "unitPriceCents",
  stock_version_after::text AS "stockVersionAfter", sellable_units_after AS "sellableUnitsAfter"
`;

async function createOrder(orderId, itemId, quantity) {
  const client = await pool.connect();
  let committed = false;
  let brokenClient;
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const reservation = await client.query(`
      INSERT INTO orders (id, menu_item_id, quantity, unit_price_cents)
      SELECT $1::uuid, id, $3::integer, price_cents FROM menu_items WHERE id = $2
      ON CONFLICT (id) DO NOTHING RETURNING id
    `, [orderId, itemId, quantity]);
    if (!reservation.rowCount) {
      const { rows: [prior] } = await client.query(
        'SELECT ' + receiptColumns + ' FROM orders WHERE id = $1', [orderId],
      );
      if (!prior) return { status: 404, body: { code: 'ITEM_NOT_FOUND' } };
      if (prior.itemId !== itemId || prior.quantity !== quantity) {
        return { status: 409, body: { code: 'ORDER_ID_CONFLICT' } };
      }
      return { status: 200, body: prior };
    }
    const { rows: ingredients } = await client.query(`
      SELECT i.id, i.on_hand, r.units_per_item FROM recipe_ingredients r
      JOIN ingredients i ON i.id = r.ingredient_id
      WHERE r.menu_item_id = $1 ORDER BY i.id FOR UPDATE OF i
    `, [itemId]);
    if (!ingredients.length) return { status: 404, body: { code: 'RECIPE_NOT_FOUND' } };
    if (ingredients.some((row) => Math.floor(row.on_hand / row.units_per_item) < quantity)) {
      return { status: 409, body: { code: 'INSUFFICIENT_INVENTORY' } };
    }
    await client.query(`
      UPDATE ingredients i
      SET on_hand = i.on_hand - r.units_per_item * $2::integer, revision = i.revision + 1
      FROM recipe_ingredients r WHERE r.ingredient_id = i.id AND r.menu_item_id = $1
    `, [itemId, quantity]);
    const { rows: [receipt] } = await client.query(`
      UPDATE orders SET stock_version_after = snapshot.version, sellable_units_after = snapshot.units
      FROM (
        SELECT SUM(i.revision) AS version, MIN(i.on_hand / r.units_per_item) AS units
        FROM recipe_ingredients r JOIN ingredients i ON i.id = r.ingredient_id
        WHERE r.menu_item_id = $2
      ) snapshot
      WHERE orders.id = $1
      RETURNING ` + receiptColumns, [orderId, itemId]);
    await client.query('COMMIT');
    committed = true;
    return { status: 201, body: receipt, ingredients: ingredients.map((row) => row.id) };
  } finally {
    if (!committed) {
      try {
        await client.query('ROLLBACK');
      } catch (error) {
        brokenClient = error;
      }
    }
    client.release(brokenClient);
  }
}

app.get('/healthz', (_req, res) => res.json({ mode, ttl, poolMax }));
app.get('/metrics', (_req, res) => res.json(metrics));
app.get('/menu', asyncRoute(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT id AS "itemId", name, price_cents AS "priceCents" FROM menu_items ORDER BY id
  `);
  res.json(rows);
}));
app.get('/menu/items/:id', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  if (!/^[0-9]+$/.test(req.params.id) || !positiveInt(id)) {
    return res.status(400).json({ code: 'INVALID_ITEM_ID' });
  }
  const item = await cachedItem(id);
  return item ? res.json(item) : res.status(404).json({ code: 'ITEM_NOT_FOUND' });
}));
app.post('/orders', asyncRoute(async (req, res) => {
  const { orderId, itemId, quantity } = req.body ?? {};
  if (typeof orderId !== 'string' || !uuid.test(orderId)
      || !positiveInt(itemId) || !positiveInt(quantity)) {
    return res.status(400).json({ code: 'INVALID_ORDER' });
  }
  const result = await createOrder(orderId, itemId, quantity);
  if ((mode === 'ttl-invalidate' || fenced) && result.status === 201) await invalidate(result.ingredients);
  return res.status(result.status).json(result.body);
}));
app.use((_req, res) => res.status(404).json({ code: 'ROUTE_NOT_FOUND' }));
app.use((error, _req, res, _next) => {
  if (error.type === 'entity.parse.failed') return res.status(400).json({ code: 'INVALID_JSON' });
  if (error.type === 'entity.too.large') return res.status(413).json({ code: 'BODY_TOO_LARGE' });
  console.error('Request failed:', error.code || error.name, error.message);
  return res.status(500).json({ code: 'INTERNAL_ERROR' });
});

async function main() {
  const { rows } = await pool.query(
    'SELECT ingredient_id, menu_item_id FROM recipe_ingredients ORDER BY ingredient_id, menu_item_id',
  );
  for (const { ingredient_id: ingredient, menu_item_id: item } of rows) {
    if (!itemsByIngredient.has(ingredient)) itemsByIngredient.set(ingredient, []);
    itemsByIngredient.get(ingredient).push(item);
  }
  if (redis) {
    let timer;
    try {
      await Promise.race([
        redis.connect(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Redis startup deadline exceeded')), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  const server = app.listen(port, bindHost, () => {
    console.log('POS API listening on port ' + port + ' with CACHE_MODE=' + mode);
  });
  function stop() {
    server.close(async () => {
      if (redis?.isOpen) await redis.disconnect();
      await pool.end();
    });
  }
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

main().catch((error) => {
  console.error('Startup failed:', error.message);
  process.exitCode = 1;
  if (redis?.isOpen) redis.disconnect().catch(() => {});
  pool.end().catch(() => {});
});
