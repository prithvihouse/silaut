'use strict';

const {MAX_INT, SHIFT_LOCK, UUID, positiveInt, nonnegativeInt, failure, transaction, lockRequest, lockInventory} = require('./db');
const revisionPattern = /^\d{1,19}$/;
const inventoryFields = `id,name,unit,on_hand AS "onHand",low_stock_threshold AS "lowStockThreshold",revision::text,
  unit_cost_millicents AS "standardUnitCostMillicents",demo_assumption AS "demoAssumption"`;
const movementFields = `m.id::text,m.ingredient_id AS "ingredientId",m.delta,m.unit,m.balance_after AS "balanceAfter",
  m.kind,m.occurred_at AS "occurredAt",m.reason,m.reference,m.order_id AS "orderId",
  m.adjustment_id AS "adjustmentId",m.purchase_cost_cents AS "purchaseCostCents",
  m.standard_unit_cost_millicents AS "standardUnitCostMillicents"`;

async function recordMovement(client, ingredient, movement) {
  const {kind, delta, reason = null, reference = null, orderId = null, shiftId = null,
    adjustmentId = null, request = null, purchaseCostCents = null} = movement;
  const balance = ingredient.on_hand + delta;
  if (delta !== 0) {
    await client.query('UPDATE ingredients SET on_hand=$2,revision=revision+1 WHERE id=$1', [ingredient.id, balance]);
  }
  const {rows: [record]} = await client.query(`
    INSERT INTO inventory_movements AS m (ingredient_id,delta,unit,balance_after,kind,reason,reference,
      order_id,shift_id,adjustment_id,adjustment_request,purchase_cost_cents,standard_unit_cost_millicents)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)
    RETURNING ${movementFields}
  `, [ingredient.id, delta, ingredient.unit, balance, kind, reason, reference, orderId, shiftId,
    adjustmentId, request, purchaseCostCents, kind === 'sale' ? ingredient.unit_cost_millicents : null]);
  return record;
}

function optionalText(value, limit) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value.trim() || null;
}

function normalizeAdjustment(body) {
  const {adjustmentId, kind, quantity, purchaseCostCents = null, expectedRevision = null} = body ?? {};
  if (typeof adjustmentId !== 'string' || !UUID.test(adjustmentId) || !['receive', 'waste', 'count'].includes(kind)) return null;
  if (kind === 'count' ? !nonnegativeInt(quantity) : !positiveInt(quantity)) return null;
  if (purchaseCostCents !== null && (kind !== 'receive' || !nonnegativeInt(purchaseCostCents))) return null;
  if (expectedRevision !== null && (kind !== 'count' || typeof expectedRevision !== 'string'
    || !revisionPattern.test(expectedRevision))) return null;
  const reason = optionalText(body.reason, 240);
  const reference = optionalText(body.reference, 120);
  if (reason === undefined || reference === undefined || (kind === 'waste' && !reason)) return null;
  return {adjustmentId: adjustmentId.toLowerCase(), kind, quantity, reason, reference, purchaseCostCents, expectedRevision};
}

async function adjustInventory(pool, id, body) {
  const input = normalizeAdjustment(body);
  if (!input) return failure(400, 'INVALID_ADJUSTMENT');
  const {adjustmentId, kind, quantity, reason, reference, purchaseCostCents, expectedRevision} = input;
  const request = JSON.stringify({id, kind, quantity, reason, reference, purchaseCostCents, expectedRevision});
  return transaction(pool, async client => {
    await lockRequest(client, 'adjustment', adjustmentId);
    const {rows: [previous]} = await client.query(`
      SELECT ${movementFields},m.adjustment_request=$2::jsonb AS matches
      FROM inventory_movements m WHERE adjustment_id=$1
    `, [adjustmentId, request]);
    if (previous) {
      const {matches, ...movement} = previous;
      return matches ? {status: 200, body: movement} : failure(409, 'ADJUSTMENT_ID_CONFLICT');
    }
    await client.query('SELECT pg_advisory_xact_lock_shared($1)', [SHIFT_LOCK]);
    const [ingredient] = await lockInventory(client, [id]);
    if (!ingredient) return failure(404, 'INGREDIENT_NOT_FOUND');
    if (expectedRevision !== null && expectedRevision !== ingredient.revision) {
      return failure(409, 'STOCK_CHANGED', {onHand: ingredient.on_hand, revision: ingredient.revision});
    }
    const delta = kind === 'count' ? quantity - ingredient.on_hand : kind === 'waste' ? -quantity : quantity;
    const balance = ingredient.on_hand + delta;
    if (balance < 0) return failure(409, 'NEGATIVE_STOCK', {onHand: ingredient.on_hand});
    if (balance > MAX_INT) return failure(400, 'INVALID_ADJUSTMENT');
    const {rows: [shift]} = await client.query('SELECT id FROM shifts WHERE closed_at IS NULL');
    const movement = await recordMovement(client, ingredient, {
      kind, delta, reason, reference, adjustmentId, purchaseCostCents, request, shiftId: shift?.id,
    });
    return {status: 201, body: movement, ingredients: delta ? [id] : []};
  });
}

function ingredientId(req) {
  return /^\d+$/.test(req.params.id) && positiveInt(Number(req.params.id)) ? Number(req.params.id) : null;
}

function inventoryRoutes(app, pool, route, onStockChange) {
  app.get('/stock', route(async (_req, res) => {
    const {rows: ingredients} = await pool.query('SELECT ' + inventoryFields + ' FROM ingredients ORDER BY name,id');
    res.json({ingredients, refreshedAt: new Date().toISOString()});
  }));
  app.get('/inventory/ingredients/:id', route(async (req, res) => {
    const id = ingredientId(req);
    const before = req.query.before;
    if (!id || (before !== undefined && (typeof before !== 'string' || !revisionPattern.test(before)
      || BigInt(before) > 9223372036854775807n))) return res.status(400).json({code: 'INVALID_INGREDIENT_QUERY'});
    const {rows: [ingredient]} = await pool.query('SELECT ' + inventoryFields + ' FROM ingredients WHERE id=$1', [id]);
    if (!ingredient) return res.status(404).json({code: 'INGREDIENT_NOT_FOUND'});
    const {rows} = await pool.query(`
      SELECT ${movementFields},o.ticket_no::text AS "ticketNumber"
      FROM inventory_movements m LEFT JOIN orders o ON o.id=m.order_id
      WHERE m.ingredient_id=$1 AND ($2::bigint IS NULL OR m.id<$2) ORDER BY m.id DESC LIMIT 51
    `, [id, before ?? null]);
    const movements = rows.slice(0, 50);
    res.json({ingredient, movements, nextBefore: rows.length > 50 ? movements.at(-1).id : null});
  }));
  app.post('/inventory/ingredients/:id/movements', route(async (req, res) => {
    const id = ingredientId(req);
    if (!id) return res.status(400).json({code: 'INVALID_INGREDIENT_ID'});
    const result = await adjustInventory(pool, id, req.body);
    if (result.ingredients?.length) await onStockChange(result.ingredients);
    res.status(result.status).json(result.body);
  }));
  app.patch('/inventory/ingredients/:id/cost', route(async (req, res) => {
    const id = ingredientId(req);
    const cost = req.body?.standardUnitCostMillicents;
    if (!id || (cost !== null && !nonnegativeInt(cost))) return res.status(400).json({code: 'INVALID_STANDARD_COST'});
    const {rows: [ingredient]} = await pool.query(`
      UPDATE ingredients SET unit_cost_millicents=$2 WHERE id=$1 RETURNING ${inventoryFields}
    `, [id, cost]);
    return ingredient ? res.json(ingredient) : res.status(404).json({code: 'INGREDIENT_NOT_FOUND'});
  }));
}

module.exports = {recordMovement, inventoryRoutes};
