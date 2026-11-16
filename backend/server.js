'use strict';

const express = require('express');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Pool } = require('pg');
const { createClient } = require('redis');
const { refillGate } = require('./refill_gate');
const {normalizeOrder, createOrder, positiveInt} = require('./checkout');
const {LOGO_REQUEST_LIMIT, profileRoutes} = require('./profile');
const {inventoryRoutes} = require('./inventory');
const {kitchenRoutes} = require('./kitchen');
const {salesRoutes} = require('./sales');

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
app.set('trust proxy', 1);
app.use((req,res,next)=>{
  res.set('Cache-Control','no-store');
  res.set('X-Content-Type-Options','nosniff');
  if (['POST','PATCH','PUT','DELETE'].includes(req.method)) {
    if (!req.is('application/json')) {
      const legacyOrder=req.method==='POST' && req.path==='/orders';
      return res.status(legacyOrder?400:415).json({code:legacyOrder?'INVALID_ORDER':'JSON_REQUIRED'});
    }
    const origin=req.get('origin');
    if (origin) {try {if(new URL(origin).origin!==req.protocol+'://'+req.get('host')) return res.status(403).json({code:'ORIGIN_REJECTED'});}catch{return res.status(403).json({code:'ORIGIN_REJECTED'});}}
  }
  if(req.url.startsWith('/api/')) req.url=req.url.slice(4);
  next();
});
const orderJson = express.json({limit: '8kb'});
const profileJson = express.json({limit: LOGO_REQUEST_LIMIT});
app.use((req, res, next) => (
  req.path === '/settings/profile' && req.method === 'PUT' ? profileJson : orderJson
)(req, res, next));
const keyFor = (id) => 'pos:menu:' + id;
const generationFor = (id) => 'pos:generation:' + id;
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
    WHERE m.id = $1 AND m.archived_at IS NULL AND m.unavailable_reason IS NULL
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
  if (mode !== 'ttl-invalidate' && !fenced) return;
  metrics.invalidationAttempts += 1;
  try {
    const {rows} = await pool.query(`
      SELECT menu_item_id FROM recipe_ingredients WHERE ingredient_id=ANY($1::int[])
      UNION SELECT menu_item_id FROM menu_modifier_ingredients WHERE ingredient_id=ANY($1::int[])
    `, [ingredients]);
    if (!rows.length) return;
    const items = rows.map(row => row.menu_item_id);
    const keys = items.map(keyFor);
    const command = fenced
      ? ['EVAL', invalidates, String(keys.length * 2), ...keys, ...items.map(generationFor)]
      : ['DEL', ...keys];
    metrics.deletedKeys += await cacheCommand(command);
  } catch (_) {
    metrics.invalidationErrors += 1;
  }
}

app.get('/healthz', asyncRoute(async (_req,res)=>{await pool.query('SELECT 1');res.json({status:'ok',app:'Silaut',mode,ttl,poolMax});}));
app.get('/metrics', (_req, res) => res.json(metrics));
app.get('/menu', asyncRoute(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT id AS "itemId", name, price_cents AS "priceCents" FROM menu_items WHERE archived_at IS NULL AND unavailable_reason IS NULL ORDER BY id
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
  const normalized = normalizeOrder(req.body);
  if (!normalized) return res.status(400).json({code:'INVALID_ORDER'});
  const result = await createOrder(pool, normalized);
  if (result.ingredients?.length) await invalidate(result.ingredients);
  return res.status(result.status).json(result.body);
}));
app.get('/catalog', asyncRoute(async (_req, res) => {
  const {rows: items} = await pool.query(`
    WITH active AS (
      SELECT * FROM menu_items WHERE archived_at IS NULL
    ), components AS (
      SELECT a.id,ri.ingredient_id,ri.units_per_item AS quantity
      FROM active a JOIN recipe_ingredients ri ON ri.menu_item_id=a.id
      UNION ALL
      SELECT a.id,part.key::integer,part.value::integer
      FROM active a
      CROSS JOIN LATERAL jsonb_array_elements(a.modifier_groups) g
      CROSS JOIN LATERAL jsonb_array_elements(g->'options') opt
      CROSS JOIN LATERAL jsonb_each_text(opt->'ingredientDeltas') part
      WHERE opt->>'default'='true'
    ), recipe AS (
      SELECT id,ingredient_id,sum(quantity) AS quantity FROM components GROUP BY id,ingredient_id HAVING sum(quantity)>0
    ), balance AS (
      SELECT r.id,min(i.on_hand/r.quantity)::integer AS sellable
      FROM recipe r JOIN ingredients i ON i.id=r.ingredient_id GROUP BY r.id
    )
    SELECT a.id AS "itemId",a.name,a.category,a.description,a.portion,a.station,
      CASE WHEN a.price_cents=0 AND a.unavailable_reason IS NOT NULL THEN NULL ELSE a.price_cents END AS "priceCents",
      a.unavailable_reason AS "unavailableReason",a.price_source_url AS "priceSourceUrl",a.price_channel AS "priceChannel",
      a.price_checked_on::text AS "priceCheckedOn",a.modifier_groups AS "modifierGroups",
      coalesce(b.sellable,0) AS "sellableUnits",coalesce(b.sellable,0)>0 AND a.unavailable_reason IS NULL AS available
    FROM active a LEFT JOIN balance b ON b.id=a.id ORDER BY a.id
  `);
  res.json({items, refreshedAt: new Date().toISOString()});
}));
profileRoutes(app, pool, asyncRoute);
inventoryRoutes(app, pool, asyncRoute, invalidate);
kitchenRoutes(app, pool, asyncRoute);
salesRoutes(app, pool, asyncRoute);
const staticRoot=join(__dirname,'../frontend/dist');
app.use(express.static(staticRoot,{index:false,etag:true,maxAge:0}));
app.get(['/', '/cashier', '/kitchen', '/inventory', '/settings', '/sales'],(_req,res)=>res.sendFile(join(staticRoot,'index.html')));
app.use((_req, res) => res.status(404).json({ code: 'ROUTE_NOT_FOUND' }));
app.use((error, _req, res, _next) => {
  if (error.type === 'entity.parse.failed') return res.status(400).json({ code: 'INVALID_JSON' });
  if (error.type === 'entity.too.large') return res.status(413).json({ code: 'BODY_TOO_LARGE' });
  console.error('Request failed:', error.code || error.name, error.message);
  return res.status(500).json({ code: 'INTERNAL_ERROR' });
});

async function main() {
  await pool.query('SELECT singleton FROM restaurant_profile WHERE singleton');
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
    console.log('Silaut API listening on port ' + port + ' with CACHE_MODE=' + mode);
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
