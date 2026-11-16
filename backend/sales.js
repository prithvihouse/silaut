'use strict';

const {SHIFT_LOCK, UUID, failure, transaction} = require('./db');

const fields = `id,opened_at AS "openedAt",closed_at AS "closedAt",report`;
const validDate = value => typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value)
  && !value.startsWith('0000') && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

async function salesReport(client, scope, value) {
  const column = scope === 'date' ? 'business_date' : 'shift_id';
  const {rows: [row]} = await client.query(`
    WITH scoped AS (
      SELECT id,total_cents,created_at,ready_at,food_cost_millicents
      FROM orders WHERE ${column}=$1 AND receipt IS NOT NULL
    ), totals AS (
      SELECT coalesce(sum(total_cents),0) AS sales,count(*) AS orders,
        count(ready_at) AS ready_orders,avg(extract(epoch FROM ready_at-created_at)) AS ready_seconds,
        count(food_cost_millicents) AS covered_orders,
        coalesce(sum(total_cents) FILTER (WHERE food_cost_millicents IS NOT NULL),0) AS covered_sales,
        sum(food_cost_millicents) AS covered_food_cost
      FROM scoped
    ), items AS (
      SELECT l.menu_item_id AS "itemId",
        (array_agg(l.item_name ORDER BY o.created_at DESC,o.id,l.line_no))[1] AS name,
        sum(l.quantity)::float8 AS units,
        sum(l.quantity::bigint*l.unit_price_cents)::float8 AS "salesCents"
      FROM scoped o JOIN order_items l ON l.order_id=o.id GROUP BY l.menu_item_id
    )
    SELECT sales::float8 AS "salesCents",orders::float8 AS "orderCount",
      round(sales/nullif(orders,0))::float8 AS "averageTicketCents",
      ready_orders::float8 AS "readyOrderCount",round(ready_seconds)::float8 AS "averageReadySeconds",
      covered_orders::float8 AS "coveredOrders",covered_sales::float8 AS "coveredSalesCents",
      round(covered_food_cost/1000)::float8 AS "coveredFoodCostCents",
      round(covered_food_cost*10/nullif(covered_sales,0))::float8 AS "foodCostBasisPoints",
      coalesce((SELECT json_agg(top) FROM (
        SELECT * FROM items ORDER BY units DESC,"salesCents" DESC,"itemId" LIMIT 10
      ) top),'[]') AS "topByUnits",
      coalesce((SELECT json_agg(top) FROM (
        SELECT * FROM items ORDER BY "salesCents" DESC,units DESC,"itemId" LIMIT 10
      ) top),'[]') AS "topBySales"
    FROM totals
  `, [value]);
  return row;
}

async function openShift(pool, id) {
  return transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [SHIFT_LOCK]);
    const {rows: [prior]} = await client.query('SELECT ' + fields + ' FROM shifts WHERE id=$1', [id]);
    if (prior) return {status: 200, body: prior};
    const {rows: [active]} = await client.query('SELECT id FROM shifts WHERE closed_at IS NULL');
    if (active) return failure(409, 'SHIFT_ALREADY_OPEN', {shiftId: active.id});
    const {rows: [shift]} = await client.query('INSERT INTO shifts (id) VALUES ($1) RETURNING ' + fields, [id]);
    return {status: 201, body: shift};
  });
}

async function closeShift(pool, id) {
  return transaction(pool, async client => {
    // Checkouts, stock changes, and station updates acquire the shared lock.
    // This window and snapshot agree even when a work request races close.
    await client.query('SELECT pg_advisory_xact_lock($1)', [SHIFT_LOCK]);
    const {rows: [shift]} = await client.query('SELECT ' + fields + ' FROM shifts WHERE id=$1', [id]);
    if (!shift) return failure(404, 'SHIFT_NOT_FOUND');
    if (shift.report) return {status: 200, body: shift};
    const {rows: [clock]} = await client.query('SELECT clock_timestamp() AS time');
    const metrics = await salesReport(client, 'shift', id);
    const {rows: waste} = await client.query(`
      SELECT i.id AS "ingredientId",i.name,m.unit,-sum(m.delta)::float8 AS quantity,count(*)::float8 AS movements
      FROM inventory_movements m JOIN ingredients i ON i.id=m.ingredient_id
      WHERE m.shift_id=$1 AND m.kind='waste' GROUP BY i.id,i.name,m.unit ORDER BY i.name,m.unit
    `, [id]);
    const report = {shiftId: id, openedAt: shift.openedAt, closedAt: clock.time, simulated: true, ...metrics, waste};
    const {rows: [saved]} = await client.query('UPDATE shifts SET closed_at=$2,report=$3::jsonb WHERE id=$1 RETURNING ' + fields,
      [id, clock.time, JSON.stringify(report)]);
    return {status: 200, body: saved};
  });
}

function csvCell(value) {
  const text = String(value ?? '');
  const safe = typeof value === 'string' && /^[\s\ufeff]*[=+\-@]/.test(text) ? "'" + text : text;
  return '"' + safe.replaceAll('"', '""') + '"';
}

function shiftCsv(report) {
  const rows = [
    ['Metric', 'Value'],
    ['Shift ID', report.shiftId], ['Opened (UTC)', report.openedAt], ['Closed (UTC)', report.closedAt],
    ['Sales mode', 'Simulated'], ['Sales (cents)', report.salesCents], ['Orders', report.orderCount],
    ['Average ticket (cents)', report.averageTicketCents], ['Average checkout-to-Ready (seconds)', report.averageReadySeconds],
    ['Orders timed', report.readyOrderCount], ['Orders with cost', report.coveredOrders],
    ['Covered sales (cents)', report.coveredSalesCents], ['Estimated covered food cost (cents)', report.coveredFoodCostCents],
    ['Estimated food cost (% of covered sales)', report.foodCostBasisPoints === null ? null : report.foodCostBasisPoints / 100],
    [], ['Top items by units', 'Units', 'Sales (cents)'],
    ...report.topByUnits.map(item => [item.name, item.units, item.salesCents]),
    [], ['Top items by sales', 'Units', 'Sales (cents)'],
    ...report.topBySales.map(item => [item.name, item.units, item.salesCents]),
    [], ['Waste ingredient', 'Quantity', 'Unit', 'Movements'],
    ...report.waste.map(item => [item.name, item.quantity, item.unit, item.movements]),
  ];
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function salesRoutes(app, pool, route) {
  app.get('/sales/daily', route(async (req, res) => {
    const date = req.query.date;
    if (date !== undefined && !validDate(date)) return res.status(400).json({code: 'INVALID_BUSINESS_DATE'});
    const {rows: [today]} = await pool.query(`
      SELECT silaut_business_day(clock_timestamp(),cutoff_minutes)::text AS date,
        cutoff_minutes AS "cutoffMinutes" FROM restaurant_profile WHERE singleton
    `);
    const businessDate = date ?? today.date;
    res.json({date: businessDate, timezone: 'America/New_York', cutoffMinutes: today.cutoffMinutes,
      simulated: true, ...await salesReport(pool, 'date', businessDate)});
  }));
  app.get('/shifts', route(async (_req, res) => {
    const {rows} = await pool.query('SELECT ' + fields + ' FROM shifts ORDER BY opened_at DESC,id LIMIT 30');
    res.json({active: rows.find(shift => !shift.closedAt) ?? null, recent: rows.filter(shift => shift.closedAt)});
  }));
  app.post('/shifts/open', route(async (req, res) => {
    const id = req.body?.shiftId;
    if (typeof id !== 'string' || !UUID.test(id)) return res.status(400).json({code: 'INVALID_SHIFT_ID'});
    const result = await openShift(pool, id.toLowerCase());
    res.status(result.status).json(result.body);
  }));
  app.post('/shifts/:id/close', route(async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(400).json({code: 'INVALID_SHIFT_ID'});
    const result = await closeShift(pool, req.params.id.toLowerCase());
    res.status(result.status).json(result.body);
  }));
  app.get('/shifts/:id/report.csv', route(async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(400).json({code: 'INVALID_SHIFT_ID'});
    const {rows: [shift]} = await pool.query('SELECT report FROM shifts WHERE id=$1', [req.params.id]);
    if (!shift?.report) return res.status(404).json({code: 'REPORT_NOT_FOUND'});
    res.attachment('silaut-shift-' + req.params.id + '.csv').send(shiftCsv(shift.report));
  }));
}

module.exports = {salesRoutes};
