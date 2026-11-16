import React, {useRef, useState} from 'react';
import {Download, Printer} from 'lucide-react';
import {api} from './api';
import {Problem, cutoffTime, money, timestamp, usePoll} from './workspace';

const numeric = value => value.toLocaleString('en-US');
const duration = seconds => seconds === null ? '—' : Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';

function ReportNumbers({report}) {
  const {salesCents, orderCount, averageTicketCents, averageReadySeconds, readyOrderCount,
    coveredOrders, coveredSalesCents, foodCostBasisPoints} = report;
  const percent = foodCostBasisPoints === null ? '—' : (foodCostBasisPoints / 100).toFixed(2) + '%';
  return <dl className="report-metrics">
    <div><dt>Sales</dt><dd>{money(salesCents)}</dd><small>Charged items and modifiers</small></div>
    <div><dt>Orders</dt><dd>{numeric(orderCount)}</dd><small>Committed checkouts</small></div>
    <div><dt>Average ticket</dt><dd>{money(averageTicketCents)}</dd><small>Sales divided by orders</small></div>
    <div><dt>Time to Ready</dt><dd>{duration(averageReadySeconds)}</dd><small>{readyOrderCount} completed {readyOrderCount === 1 ? 'order' : 'orders'} timed</small></div>
    <div><dt>Estimated food cost</dt><dd>{percent}</dd><small>{foodCostBasisPoints === null ? 'Insufficient covered sales' : 'Of covered sales only'}</small></div>
    <div><dt>Cost coverage</dt><dd>{coveredOrders} / {orderCount}</dd><small>{money(coveredSalesCents)} in sales with recorded cost</small></div>
  </dl>;
}

function TopItems({report}) {
  const [sort, setSort] = useState('units');
  const ranked = sort === 'units' ? report.topByUnits : report.topBySales;
  return <section className="top-items">
    <div className="section-heading split"><h3>Top items</h3>
      <div className="categories report-sort" aria-label="Rank top items">
        <button type="button" aria-pressed={sort === 'units'} onClick={() => setSort('units')}>By units</button>
        <button type="button" aria-pressed={sort === 'sales'} onClick={() => setSort('sales')}>By sales</button>
      </div></div>
    {ranked.length ? <div className="table-scroll"><table><thead><tr><th>Item</th><th className="number">Units</th>
      <th className="number">Sales</th></tr></thead><tbody>{ranked.map(item => <tr key={item.itemId}>
        <td>{item.name}</td><td className="number">{numeric(item.units)}</td><td className="number">{money(item.salesCents)}</td>
      </tr>)}</tbody></table></div> : <p className="empty-report">No sales for this period.</p>}
  </section>;
}

function ShiftReport({report, onClose}) {
  return <section className="surface shift-report" aria-label="Closed shift report">
    <div className="section-heading split"><div><h2>Close-of-shift report</h2>
      <p>Simulated sales · {timestamp(report.openedAt)} to {timestamp(report.closedAt)} Eastern</p></div>
      <div className="report-actions">
        <a className="secondary" href={'/api/shifts/' + report.shiftId + '/report.csv'}><Download size={16}/>Export CSV</a>
        <button className="secondary" type="button" onClick={() => window.print()}><Printer size={16}/>Print report</button>
        <button className="text-button" type="button" onClick={onClose}>Hide report</button>
      </div>
    </div>
    <ReportNumbers report={report}/>
    <TopItems report={report}/>
    <section className="top-items">
      <div className="section-heading"><h3>Waste during shift</h3></div>
      {report.waste.length ? <ul className="waste-list">{report.waste.map(row => <li key={row.ingredientId + ':' + row.unit}>
        <span>{row.name}</span><strong>{numeric(row.quantity)} {row.unit}</strong></li>)}</ul>
        : <p className="empty-report">No waste recorded during this shift.</p>}
    </section>
  </section>;
}

export function Sales() {
  const [date, setDate] = useState('');
  const daily = usePoll('/sales/daily' + (date ? '?date=' + date : ''), 7000);
  const shifts = usePoll('/shifts', 6000);
  const [selectedReport, setSelectedReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const openId = useRef(null);

  async function shiftAction(active) {
    setBusy(true);
    setProblem('');
    try {
      if (active) {
        const closed = await api('/shifts/' + active.id + '/close', {method: 'POST', body: '{}'});
        setSelectedReport(closed.report);
      } else {
        openId.current ??= crypto.randomUUID();
        await api('/shifts/open', {method: 'POST', body: JSON.stringify({shiftId: openId.current})});
        openId.current = null;
        setSelectedReport(null);
      }
    } catch (error) {
      if (error.body?.code === 'SHIFT_ALREADY_OPEN') {
        openId.current = null;
        setProblem('A shift is already open. The controls have been refreshed.');
      } else {
        setProblem('Could not confirm the shift change. Check the refreshed shift status before retrying.');
      }
    } finally {
      await Promise.all([daily.refresh(), shifts.refresh()]);
      setBusy(false);
    }
  }

  return <main className="workspace-page sales-page">
    <div className="page-heading"><div><h1>Sales<span className="green-dot">.</span></h1>
      <p>Simulated sales and shift reports.</p></div></div>
    <section className="surface daily-sales">
      <div className="section-heading split"><div><h2>Daily sales</h2>
        {daily.data && <p>Service day starts at {cutoffTime(daily.data.cutoffMinutes)} Eastern.</p>}</div>
        <label>Service date<input type="date" value={date || daily.data?.date || ''} onChange={e => setDate(e.target.value)}/></label>
      </div>
      {daily.error && <Problem>Could not load sales for this date.</Problem>}
      {daily.data ? <>
        {daily.data.orderCount === 0 && <p className="empty-report">No committed orders on this service date.</p>}
        <ReportNumbers report={daily.data}/>
        <TopItems report={daily.data}/>
      </> : !daily.error && <p>Loading sales…</p>}
    </section>
    <section className="surface shift-controls">
      <div className="section-heading split">
        <div><h2>Shifts</h2><p>{shifts.data?.active
          ? 'Open since ' + timestamp(shifts.data.active.openedAt) + ' Eastern'
          : shifts.data ? 'No open shift' : 'Loading shifts…'}</p></div>
        <button className="primary" type="button" disabled={busy || !shifts.data || shifts.error}
          onClick={() => shiftAction(shifts.data.active)}>{busy ? 'Saving…' : shifts.data?.active ? 'Close shift and save report' : 'Open shift'}</button>
      </div>
      <Problem>{problem || (shifts.error ? 'Could not load shifts.' : '')}</Problem>
      {shifts.data?.recent.length > 0 && <div className="shift-history">
        <h3>Recent reports</h3>
        <ul>{shifts.data.recent.map(shift => <li key={shift.id}><button className="text-button" type="button"
          onClick={() => setSelectedReport(shift.report)}>Closed {timestamp(shift.closedAt)}</button>
          <span>{money(shift.report.salesCents)} · {shift.report.orderCount} orders</span></li>)}</ul>
      </div>}
    </section>
    {selectedReport && <ShiftReport report={selectedReport} key={selectedReport.shiftId} onClose={() => setSelectedReport(null)}/>}
  </main>;
}
