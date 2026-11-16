'use strict';

const {SHIFT_LOCK, STATIONS, UUID, failure, transaction} = require('./db');
const predecessors = new Map([['preparing', 'new'], ['ready', 'preparing']]);
const stationFields = `station,status,status_updated_at AS "statusUpdatedAt",preparing_at AS "preparingAt",ready_at AS "readyAt"`;

async function advanceStation(pool, id, {station, status, expectedStatus}) {
  return transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock_shared($1)', [SHIFT_LOCK]);
    // Serialize the parent aggregate even when two stations finish at once.
    const {rows: [order]} = await client.query('SELECT status FROM orders WHERE id=$1 AND receipt IS NOT NULL FOR UPDATE', [id]);
    if (!order) return failure(404, 'ORDER_NOT_FOUND');
    const {rows: stations} = await client.query('SELECT ' + stationFields + ' FROM ticket_stations WHERE order_id=$1', [id]);
    if (station === undefined && stations.length !== 1) return failure(400, 'STATION_REQUIRED');
    const current = station === undefined ? stations[0] : stations.find(row => row.station === station);
    if (!current) return failure(404, 'STATION_NOT_FOUND');
    if (current.status === status) return {status: 200, body: {orderId: id, orderStatus: order.status, ...current}};
    if (current.status !== expectedStatus) return failure(409, 'STATUS_CONFLICT', {status: current.status});

    const {rows: [updated]} = await client.query(`
      WITH stamp AS (SELECT clock_timestamp() AS time)
      UPDATE ticket_stations SET status=$3,status_updated_at=time,
        preparing_at=CASE WHEN $3='preparing' THEN time ELSE preparing_at END,
        ready_at=CASE WHEN $3='ready' THEN time ELSE ready_at END
      FROM stamp WHERE order_id=$1 AND station=$2 RETURNING ${stationFields}
    `, [id, current.station, status]);
    const remaining = stations.filter(row => row.station !== current.station);
    const orderStatus = status === 'ready' && remaining.every(row => row.status === 'ready') ? 'ready' : 'preparing';
    if (orderStatus !== order.status) {
      await client.query(`
        UPDATE orders SET status=$2,status_updated_at=$3::timestamptz,
          ready_at=CASE WHEN $2='ready' THEN $3::timestamptz ELSE NULL END WHERE id=$1
      `, [id, orderStatus, updated.statusUpdatedAt]);
    }
    return {status: 200, body: {orderId: id, orderStatus, ...updated}};
  });
}

function kitchenRoutes(app, pool, route) {
  app.get('/orders/:id', route(async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(400).json({code: 'INVALID_ORDER_ID'});
    const {rows: [order]} = await pool.query(`
      SELECT receipt,status,ready_at AS "readyAt" FROM orders WHERE id=$1 AND receipt IS NOT NULL
    `, [req.params.id]);
    return order
      ? res.json({...order.receipt, kitchenStatus: order.status, readyAt: order.readyAt})
      : res.status(404).json({code: 'ORDER_NOT_FOUND'});
  }));
  app.get('/tickets', route(async (req, res) => {
    const station = req.query.station ?? null;
    if (station !== null && !STATIONS.includes(station)) return res.status(400).json({code: 'INVALID_STATION'});
    const {rows: tickets} = await pool.query(`
      WITH board AS (
        SELECT o.id,o.ticket_no,o.created_at,o.status AS order_status,o.total_cents,
          coalesce(s.status,o.status) AS board_status,coalesce(s.status_updated_at,o.status_updated_at) AS board_updated
        FROM orders o LEFT JOIN ticket_stations s ON s.order_id=o.id AND s.station=$1
        WHERE o.receipt IS NOT NULL AND ($1::text IS NULL OR s.order_id IS NOT NULL)
      ), visible AS (
        SELECT * FROM board WHERE board_status<>'ready'
        UNION ALL
        (SELECT * FROM board WHERE board_status='ready' ORDER BY board_updated DESC,ticket_no DESC LIMIT 100)
      )
      SELECT v.id AS "orderId",v.ticket_no::float8 AS "ticketNumber",v.created_at AS "createdAt",
        v.board_status AS status,v.order_status AS "orderStatus",v.board_updated AS "statusUpdatedAt",
        v.total_cents::float8 AS "totalCents",
        (SELECT json_agg(json_build_object('lineNo',l.line_no,'itemId',l.menu_item_id,'name',l.item_name,
          'quantity',l.quantity,'station',l.station,'modifiers',l.modifiers) ORDER BY l.line_no)
          FROM order_items l WHERE l.order_id=v.id AND ($1 IS NULL OR l.station=$1)) AS items,
        (SELECT json_agg(s ORDER BY s.station) FROM (
          SELECT ${stationFields} FROM ticket_stations WHERE order_id=v.id AND ($1 IS NULL OR station=$1)
        ) s) AS stations
      FROM visible v ORDER BY v.created_at,v.ticket_no
    `, [station]);
    res.json({tickets, refreshedAt: new Date().toISOString()});
  }));
  app.patch('/tickets/:id/status', route(async (req, res) => {
    const {status, expectedStatus, station} = req.body ?? {};
    if (!UUID.test(req.params.id) || !predecessors.has(status) || predecessors.get(status) !== expectedStatus
      || (station !== undefined && !STATIONS.includes(station))) return res.status(400).json({code: 'INVALID_TRANSITION'});
    const result = await advanceStation(pool, req.params.id, {status, expectedStatus, station});
    res.status(result.status).json(result.body);
  }));
}

module.exports = {kitchenRoutes};
