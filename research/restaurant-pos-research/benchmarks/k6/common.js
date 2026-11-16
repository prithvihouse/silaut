import http from 'k6/http';
import exec from 'k6/execution';
import { sleep } from 'k6';
import { Counter, Trend, Gauge } from 'k6/metrics';

const settings = JSON.parse(open(__ENV.POS_SETTINGS));
const fixture = JSON.parse(open(__ENV.POS_FIXTURE));
const baseUrl = __ENV.POS_BASE_URL;
export const phase = __ENV.POS_PHASE;
export const workload = __ENV.POS_WORKLOAD;
export const vus = Number(__ENV.POS_VUS);
export const duration = Number(__ENV.POS_DURATION_S);
const seed = Number(__ENV.POS_WORKLOAD_SEED);
const starts = new Counter('pos_started');
const latencies = new Trend('pos_http_ms', true);
const probes = new Gauge('pos_probe');
const probeStarts = new Counter('pos_probe_started');

export const systemTags = ['name', 'method', 'status', 'error_code', 'scenario'];

export function constantVus(count, handler) {
  return {
    executor: 'constant-vus',
    vus: count,
    duration: String(duration) + 's',
    gracefulStop: String(settings.graceful_stop_s) + 's',
    exec: handler,
  };
}

function hash32(value) {
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return (value ^ (value >>> 16)) >>> 0;
}

const phaseSalt = phase === 'warmup' ? 0x1c1253f0 : 0x2e981b07;

function itemFor(index, probe) {
  const hash = hash32(index ^ seed ^ phaseSalt ^ (probe ? 0x726e5511 : 0x4f223731));
  const hot = probe || hash % 100 < settings.hot_percent;
  const pool = hot ? fixture.hot_item_ids : fixture.other_item_ids;
  return pool[hash32(hash ^ 0x88dfca61) % pool.length];
}

function orderId(index, lane) {
  const prefix = hash32(seed).toString(16).padStart(8, '0');
  const scope = lane === 'probe' ? '0003' : phase === 'warmup' ? '0001' : '0002';
  return [prefix, scope, '4000', '8000', index.toString(16).padStart(12, '0')].join('-');
}

function version(value) {
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return value;
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function versionBefore(left, right) {
  return left.length === right.length ? left < right : left.length < right.length;
}

function units(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function decode(response) {
  try {
    return response.json();
  } catch (_) {
    return null;
  }
}

function stockout(body) {
  return (body?.code ?? body?.error?.code ?? body?.error) === 'INSUFFICIENT_INVENTORY';
}

function classify(response, endpoint, itemId, id) {
  if (response.status === 0) return { outcome: 'failure', reason: 'transport' };
  if (endpoint === 'order_create' && response.status === 409 && stockout(decode(response))) {
    return { outcome: 'business_rejection', reason: 'insufficient_inventory' };
  }
  const wanted = endpoint === 'menu_item' ? 200 : 201;
  if (response.status !== wanted) return { outcome: 'failure', reason: 'unexpected_status' };

  const body = decode(response);
  const stockVersion = version(body?.stockVersion ?? body?.stockVersionAfter);
  const availability = units(endpoint === 'menu_item' ? body?.sellableUnits : body?.sellableUnitsAfter);
  if (endpoint === 'menu_item') {
    if (body?.itemId !== itemId || stockVersion === null || availability === null
        || body?.available !== (availability > 0)) {
      return { outcome: 'failure', reason: 'invalid_item_snapshot' };
    }
  } else if (body?.orderId !== id || body?.itemId !== itemId || body?.quantity !== 1
             || stockVersion === null || availability === null) {
    return { outcome: 'failure', reason: 'invalid_order_receipt' };
  }
  return { outcome: 'success', reason: 'ok', stockVersion, availability };
}

function request(endpoint, itemId, id, lane) {
  const tags = { endpoint, lane, phase };
  starts.add(1, tags);
  const params = { timeout: String(settings.timeout_ms) + 'ms', redirects: 0 };
  const response = endpoint === 'menu_item'
    ? http.get(baseUrl + '/menu/items/' + itemId, {
      ...params, tags: { name: 'GET /menu/items/:id' },
    })
    : http.post(baseUrl + '/orders', JSON.stringify({ orderId: id, itemId, quantity: 1 }), {
      ...params, headers: { 'Content-Type': 'application/json' }, tags: { name: 'POST /orders' },
    });
  const completedAt = Date.now();
  const result = classify(response, endpoint, itemId, id);
  latencies.add(response.timings.duration, {
    ...tags,
    status: String(response.status),
    outcome: result.outcome,
    reason: result.reason,
    window: completedAt < exec.scenario.startTime + duration * 1000 ? 'measurement' : 'drain',
  });
  return { ...result, completedAt };
}

function beforeDeadline() {
  return Date.now() < exec.scenario.startTime + duration * 1000;
}

export function traffic(readOnly, paced = true) {
  if (paced && !beforeDeadline()) return;
  const index = exec.scenario.iterationInTest;
  const writeSlot = hash32(Math.floor(index / 5) ^ seed ^ phaseSalt) % 5;
  const write = !readOnly && index % 5 === writeSlot;
  const itemId = itemFor(index, false);
  request(write ? 'order_create' : 'menu_item', itemId, write ? orderId(index, 'traffic') : null, 'traffic');
  if (paced) sleep(settings.think_ms / 1000);
}

function recordProbe(index, itemId, result, ack, read) {
  const eligible = result === 'stale' || result === 'at_least_ack';
  const comparableUnits = eligible && ack.availability !== null && read.availability !== null;
  const overstates = comparableUnits ? String(read.availability > ack.availability) : '';
  probes.add(eligible ? Math.max(0, read.completedAt - ack.completedAt) : 0, {
    probe_id: String(index),
    item_id: String(itemId),
    result,
    acknowledged_version: ack?.stockVersion ?? '',
    observed_version: read?.stockVersion ?? '',
    acknowledged_units: String(ack?.availability ?? ''),
    observed_units: String(read?.availability ?? ''),
    overstates_units: overstates,
  });
}

export function freshnessProbe() {
  if (!beforeDeadline()) return;
  const startedAt = Date.now();
  const index = exec.scenario.iterationInTest;
  const itemId = itemFor(index, true);
  probeStarts.add(1);
  const prime = request('menu_item', itemId, null, 'probe');
  if (prime.outcome !== 'success') {
    recordProbe(index, itemId, 'prime_failure', null, null);
  } else {
    const ack = request('order_create', itemId, orderId(index, 'probe'), 'probe');
    if (ack.outcome !== 'success') {
      recordProbe(index, itemId, 'order_' + ack.outcome, null, null);
    } else {
      const read = request('menu_item', itemId, null, 'probe');
      const result = read.outcome !== 'success' ? 'read_failure'
        : versionBefore(read.stockVersion, ack.stockVersion) ? 'stale' : 'at_least_ack';
      recordProbe(index, itemId, result, ack, read);
    }
  }
  const rest = settings.probe_period_ms - (Date.now() - startedAt);
  if (rest > 0) sleep(rest / 1000);
}
