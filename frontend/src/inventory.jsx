import React, {useEffect, useState} from 'react';
import {AlertCircle, Leaf, Package, RefreshCw, Search, WifiOff} from 'lucide-react';
import {api} from './api';
import {Dialog, Problem, money, time, timestamp, usePoll} from './workspace';

const movementTypes = {receive: 'Receive', waste: 'Waste', count: 'Count correction'};
const adjustmentKey = id => 'silaut.inventory.pending.' + id;
const maxQuantity = 2147483647;
const format = value => value.toLocaleString('en-US');
const withUnit = (value, unit) => format(value) + ' ' + (
  Math.abs(value) === 1 || unit === 'g' || unit === 'ml' ? unit : unit === 'patty' ? 'patties' : unit + 's');

function initialAdjustment(id) {
  try { return JSON.parse(sessionStorage.getItem(adjustmentKey(id))); }
  catch { return null; }
}

function movementTitle(movement) {
  const quantity = withUnit(Math.abs(movement.delta), movement.unit);
  if (movement.kind === 'opening') return 'Opening balance · ' + quantity;
  if (movement.kind === 'sale') return 'Used ' + quantity + ' on ticket #' + movement.ticketNumber;
  if (movement.kind === 'receive') return 'Received ' + quantity;
  if (movement.kind === 'waste') return 'Wasted ' + quantity;
  return 'Counted ' + withUnit(movement.balanceAfter, movement.unit);
}

function decimalAmount(value, decimals) {
  const pattern = new RegExp('^\\d+(?:\\.\\d{1,' + decimals + '})?$');
  if (!pattern.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const scaled = Number(whole) * 10 ** decimals + Number(fraction.padEnd(decimals, '0'));
  return Number.isSafeInteger(scaled) && scaled <= maxQuantity ? scaled : null;
}

function IngredientDetails({initial, onClose, onStockChange}) {
  const root = '/inventory/ingredients/' + initial.id;
  const {data, error, refresh} = usePoll(root, 5000);
  const ingredient = data?.ingredient ?? initial;
  const [pending, setPending] = useState(() => initialAdjustment(initial.id));
  const [kind, setKind] = useState(() => initialAdjustment(initial.id)?.request?.kind ?? 'receive');
  const [amount, setAmount] = useState('');
  const [countRevision, setCountRevision] = useState(null);
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [purchase, setPurchase] = useState('');
  const [cost, setCost] = useState(ingredient.standardUnitCostMillicents == null ? ''
    : (ingredient.standardUnitCostMillicents / 100000).toFixed(5));
  const [more, setMore] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState('');
  const quantity = /^\d+$/.test(amount) ? Number(amount) : null;
  const purchaseCents = purchase === '' ? null : decimalAmount(purchase, 2);
  const balance = quantity === null ? null : kind === 'count' ? quantity
    : ingredient.onHand + (kind === 'waste' ? -quantity : quantity);
  const projected = pending ? pending.projected : balance;
  const staleCount = kind === 'count' && countRevision !== null && countRevision !== ingredient.revision;
  const valid = quantity !== null && Number.isSafeInteger(quantity) && quantity <= maxQuantity
    && balance >= 0 && balance <= maxQuantity && (kind === 'count' ? !staleCount && countRevision !== null : quantity > 0)
    && (kind !== 'waste' || reason.trim()) && (kind !== 'receive' || purchase === '' || purchaseCents !== null);

  useEffect(() => {
    setCost(ingredient.standardUnitCostMillicents == null ? '' : (ingredient.standardUnitCostMillicents / 100000).toFixed(5));
  }, [ingredient.standardUnitCostMillicents]);

  async function saveAdjustment(event) {
    event.preventDefault();
    if (busy || (!pending && !valid)) return;
    const entry = pending ?? {projected, request: {
      adjustmentId: crypto.randomUUID(), kind, quantity, reason,
      reference: kind === 'receive' ? reference : '',
      ...(kind === 'receive' && {purchaseCostCents: purchaseCents}),
      ...(kind === 'count' && {expectedRevision: countRevision}),
    }};
    setBusy(true);
    setProblem('');
    setMessage('');
    try {
      sessionStorage.setItem(adjustmentKey(ingredient.id), JSON.stringify(entry));
      setPending(entry);
      await api(root + '/movements', {method: 'POST', body: JSON.stringify(entry.request)});
      sessionStorage.removeItem(adjustmentKey(ingredient.id));
      setPending(null);
      setAmount('');
      setCountRevision(null);
      setReference('');
      setReason('');
      setPurchase('');
      setMore(null);
      await Promise.all([refresh(), onStockChange()]);
      setMessage('Inventory movement recorded.');
    } catch (failure) {
      if ([400, 404, 409, 413, 415].includes(failure.status)) {
        sessionStorage.removeItem(adjustmentKey(ingredient.id));
        setPending(null);
        setProblem(failure.body?.code === 'STOCK_CHANGED'
          ? 'Stock changed since this count was entered. Check the current balance before confirming again.'
          : failure.body?.code === 'NEGATIVE_STOCK' ? 'This movement would make stock negative.'
            : 'Could not record the movement. Review the quantity and details.');
        refresh();
      } else {
        setProblem('The movement could not be confirmed. Retry the same submission.');
      }
    } finally { setBusy(false); }
  }

  async function saveCost(event) {
    event.preventDefault();
    const value = cost === '' ? null : decimalAmount(cost, 5);
    if (cost !== '' && value === null) {
      setProblem('Enter a dollar amount with up to five decimal places, or leave it blank.');
      return;
    }
    setBusy(true);
    setMessage('');
    setProblem('');
    try {
      await api(root + '/cost', {method: 'PATCH', body: JSON.stringify({standardUnitCostMillicents: value})});
      await Promise.all([refresh(), onStockChange()]);
      setMessage('Sample standard cost saved.');
    } catch { setProblem('Could not save the standard cost. Try again.'); }
    finally { setBusy(false); }
  }

  async function loadMore() {
    const before = more ? more.nextBefore : data?.nextBefore;
    if (!before) return;
    try {
      const result = await api(root + '?before=' + before);
      setMore(old => ({movements: [...(old?.movements ?? []), ...result.movements], nextBefore: result.nextBefore}));
    } catch { setProblem('Could not load more inventory history.'); }
  }

  const movements = [...(data?.movements ?? []), ...(more?.movements ?? [])];
  const shown = [...new Map(movements.map(move => [move.id, move])).values()];
  return <Dialog title={ingredient.name} className="workspace-dialog ingredient-dialog" onClose={onClose}>
    <div className="ingredient-balance"><div><span>On hand</span><strong>{withUnit(ingredient.onHand, ingredient.unit)}</strong></div>
      {ingredient.demoAssumption && <span className="subtle-tag">Demo inventory</span>}</div>
    {error && <Problem>Inventory could not refresh. Check the current balance before posting.</Problem>}
    <div className="ingredient-content">
      <section>
        <div className="section-heading"><h3>Record movement</h3></div>
        <form className="movement-form" onSubmit={saveAdjustment}>
          <label>Movement type<select value={kind} disabled={busy || !!pending} onChange={e => {
            setKind(e.target.value); setAmount(''); setCountRevision(null); setMessage(''); setProblem('');
          }}>{Object.entries(movementTypes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>{kind === 'count' ? 'Actual count' : 'Quantity'} <span className="optional">{ingredient.unit}</span>
            <input inputMode="numeric" value={pending?.request.quantity ?? amount}
              disabled={busy || !!pending} onChange={e => {
                const next = e.target.value;
                setAmount(next);
                if (kind === 'count') setCountRevision(previous => next === '' ? null : previous ?? ingredient.revision);
              }} required/>
          </label>
          {kind === 'receive' && <>
            <label>Delivery reference <span className="optional">Optional</span>
              <input value={pending?.request.reference ?? reference} maxLength={120} disabled={busy || !!pending}
                onChange={e => setReference(e.target.value)}/></label>
            <label>Purchase cost <span className="optional">Total USD · optional</span>
              <input inputMode="decimal" value={pending?.request.purchaseCostCents != null
                ? (pending.request.purchaseCostCents / 100).toFixed(2) : purchase}
                disabled={busy || !!pending} onChange={e => setPurchase(e.target.value)}/></label>
          </>}
          <label>Reason {kind !== 'waste' && <span className="optional">Optional</span>}
            <input value={pending?.request.reason ?? reason} maxLength={240} disabled={busy || !!pending}
              onChange={e => setReason(e.target.value)} required={kind === 'waste'}/></label>
          <div className={'projection' + (projected !== null && projected < 0 ? ' invalid' : '')}>
            <span>Projected balance</span><strong>{projected === null ? '—' : withUnit(projected, ingredient.unit)}</strong>
          </div>
          {staleCount && !pending && <div className="notice warning" role="alert">
            Stock changed during this count. Clear the quantity and enter the new physical count.
          </div>}
          <button className="primary" type="submit" disabled={busy || (!pending && (!valid || error))}>
            {busy ? 'Saving…' : pending ? 'Retry same movement' : 'Confirm movement'}</button>
        </form>
        <form className="cost-form" onSubmit={saveCost}>
          <label>Sample standard cost <span className="optional">USD per {ingredient.unit}</span>
            <input inputMode="decimal" value={cost} onChange={e => setCost(e.target.value)} disabled={busy || !!pending}/></label>
          <p>Leave blank for unknown. Changes apply to future sales.</p>
          <button className="secondary" type="submit" disabled={busy || !!pending}>Save cost</button>
        </form>
      </section>
      <section className="history-panel">
        <div className="section-heading"><h3>Inventory history</h3></div>
        {!data && !error && <p>Loading movements…</p>}
        {data && !shown.length && <p>No movements recorded yet.</p>}
        <ol className="movement-list">{shown.map(movement => <li key={movement.id}>
          <strong>{movementTitle(movement)}</strong>
          <small>{timestamp(movement.occurredAt)} · Balance {withUnit(movement.balanceAfter, movement.unit)}</small>
          {movement.kind === 'count' && <small>Change {movement.delta > 0 ? '+' : ''}{withUnit(movement.delta, movement.unit)}</small>}
          {movement.reason && <p>{movement.reason}</p>}
          {movement.reference && <p>Reference {movement.reference}</p>}
          {movement.purchaseCostCents !== null && <p>Purchase cost {money(movement.purchaseCostCents)}</p>}
        </li>)}</ol>
        {(more ? more.nextBefore : data?.nextBefore) && <button type="button" className="secondary" onClick={loadMore}>Load older movements</button>}
      </section>
    </div>
    <Problem>{problem}</Problem>
    <p className="operation-status" role="status">{message}</p>
  </Dialog>;
}

export function Inventory() {
  const {data, error, last, refresh} = usePoll('/stock');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState(null);
  const ingredients = data?.ingredients ?? [];
  const condition = ingredient => ingredient.onHand === 0 ? 'out'
    : ingredient.onHand <= ingredient.lowStockThreshold ? 'low' : 'ok';
  const rows = ingredients.filter(ingredient => (filter === 'all' || filter === condition(ingredient))
    && ingredient.name.toLowerCase().includes(query.trim().toLowerCase()));
  const filters = [
    ['all', 'Total ingredients', ingredients.length, Package],
    ['low', 'Running low', ingredients.filter(i => condition(i) === 'low').length, AlertCircle],
    ['out', 'Sold out', ingredients.filter(i => condition(i) === 'out').length, Package],
  ];
  return <main className="inventory-page">
    <div className="page-heading"><div><h1>Inventory<span className="green-dot">.</span></h1>
      <p>Stock, receiving, waste, and counts.</p></div>
      <button type="button" className="secondary" onClick={() => refresh()}><RefreshCw size={17}/>Refresh stock</button>
    </div>
    <div className="inventory-stats">{filters.map(([key, label, count, Icon]) => <button type="button" key={key}
      className={'stat ' + (filter === key ? 'selected ' : '') + (key === 'low' ? 'amber' : key === 'out' ? 'red' : '')}
      onClick={() => setFilter(key)} aria-pressed={filter === key}><span><Icon size={18}/>{label}</span><strong>{count}</strong></button>)}</div>
    <section className="inventory-panel">
      <div className="inventory-toolbar"><div><h2>Ingredients</h2><span>Select an ingredient to view history or record a movement.</span></div>
        <label className="search"><Search size={18}/><input aria-label="Search ingredients" placeholder="Search ingredients"
          value={query} onChange={e => setQuery(e.target.value)}/></label></div>
      {error && <div className="notice warning" role="status"><WifiOff size={18}/>Reconnecting to inventory…</div>}
      <div className="table-scroll"><table><thead><tr><th>Ingredient</th><th>Unit</th><th className="number">On hand</th>
        <th className="number threshold">Low at</th><th>Status</th></tr></thead>
        <tbody>{rows.map(ingredient => {
          const status = condition(ingredient);
          return <tr key={ingredient.id}>
            <td><button type="button" className="ingredient-link" onClick={() => setSelected(ingredient)}>
              <span className="ingredient-icon"><Leaf size={17}/></span>{ingredient.name}</button></td>
            <td className="unit">{ingredient.unit}</td><td className="number quantity">{format(ingredient.onHand)}</td>
            <td className="number threshold">{format(ingredient.lowStockThreshold)}</td>
            <td><span className={'stock-badge ' + status}><span/>{status === 'ok' ? 'In stock' : status === 'low' ? 'Low stock' : 'Sold out'}</span></td>
          </tr>;
        })}</tbody></table></div>
      {data && !rows.length && <div className="empty-state"><Search/><h3>{filter === 'out' ? 'Nothing sold out' : 'No matching ingredients'}</h3></div>}
      {!data && !error && <div className="loading">Loading inventory…</div>}
      <div className="table-footer"><span>{rows.length} of {ingredients.length} ingredients</span>
        <span>{error ? 'Last successful refresh' : 'Refreshed'} {time(data?.refreshedAt ?? last)}</span></div>
    </section>
    {selected && <IngredientDetails initial={selected} key={selected.id} onStockChange={refresh} onClose={() => setSelected(null)}/>}
  </main>;
}
