import React, {useEffect, useRef, useState} from 'react';
import {ArrowRight, ChefHat, Check, CheckCheck, Clock, WifiOff} from 'lucide-react';
import {api} from './api';
import {Dialog, Problem, Receipt, modifierLabel, stationNames, time, usePoll} from './workspace';

const statuses = [['new', 'New'], ['preparing', 'Preparing'], ['ready', 'Ready']];
const statusName = Object.fromEntries(statuses);

function Ticket({ticket, now, unavailable, pending, advance, openReceipt, filtered}) {
  const elapsed = Math.max(0, Math.floor(((ticket.status === 'ready' ? Date.parse(ticket.statusUpdatedAt) : now)
    - Date.parse(ticket.createdAt)) / 1000));
  return <article className={'ticket' + (elapsed >= 600 && ticket.status !== 'ready' ? ' overdue' : '')}
    aria-label={'Ticket #' + ticket.ticketNumber}>
    <div className="ticket-top">
      <div><span className="ticket-label">{filtered && ticket.orderStatus !== ticket.status
        ? 'Order ' + statusName[ticket.orderStatus] : 'Counter'}</span><h3>#{ticket.ticketNumber}</h3></div>
      <span className="ticket-timer"><Clock size={16}/>{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</span>
    </div>
    <div className="ticket-status">{statusName[ticket.status]}<span>{time(ticket.createdAt)}</span></div>
    {ticket.stations.map(work => {
      const key = ticket.orderId + ':' + work.station;
      return <section className="ticket-station" aria-label={stationNames[work.station]} key={work.station}>
        <div className="ticket-station-label"><strong>{stationNames[work.station]}</strong><span>{statusName[work.status]}</span></div>
        <ul className="ticket-items">{ticket.items.filter(line => line.station === work.station).map(line =>
          <li key={line.lineNo}>
            <b>{line.quantity}</b><span>{line.name}
              {line.modifiers?.length > 0 && <small>{line.modifiers.map(modifierLabel).join(' · ')}</small>}
            </span>
          </li>)}</ul>
        {work.status !== 'ready' && <button className="ticket-action" type="button"
          disabled={unavailable || pending[key]}
          onClick={() => advance(ticket.orderId, work)}
          aria-label={(work.status === 'new' ? 'Start preparing ' : 'Mark ready ') + stationNames[work.station]}>
          {pending[key] ? 'Updating…' : work.status === 'new' ? 'Start preparing' : 'Mark ready'}
          {work.status === 'new' ? <ArrowRight size={18}/> : <Check size={18}/>}
        </button>}
      </section>;
    })}
    {ticket.status === 'ready' && <div className="ready-label"><CheckCheck size={18}/>
      {ticket.orderStatus === 'ready' ? 'Ready to serve' : 'Station complete'}</div>}
    <button type="button" className="text-button ticket-receipt-button" onClick={() => openReceipt(ticket)}>
      View receipt <span className="visually-hidden">for ticket #{ticket.ticketNumber}</span>
    </button>
  </article>;
}

export function Kitchen() {
  const [station, setStation] = useState('');
  const {data, error, last, refresh} = usePoll('/tickets' + (station ? '?station=' + station : ''));
  const [now, setNow] = useState(Date.now());
  const [pending, setPending] = useState({});
  const [problem, setProblem] = useState('');
  const [receiptView, setReceiptView] = useState(null);
  const locks = useRef(new Set());
  const receiptRequest = useRef(null);
  const disconnected = error || (last !== null && now - last > 6000);
  const tickets = data?.tickets ?? [];

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  async function advance(id, work) {
    const key = id + ':' + work.station;
    if (locks.current.has(key)) return;
    locks.current.add(key);
    setPending(old => ({...old, [key]: true}));
    setProblem('');
    try {
      await api('/tickets/' + id + '/status', {method: 'PATCH', body: JSON.stringify({
        station: work.station, expectedStatus: work.status, status: work.status === 'new' ? 'preparing' : 'ready',
      })});
    } catch {
      setProblem('Could not confirm the station update. Check the refreshed ticket before retrying.');
    } finally {
      await refresh();
      locks.current.delete(key);
      setPending(old => { const next = {...old}; delete next[key]; return next; });
    }
  }

  async function openReceipt(ticket) {
    const id = ticket.orderId;
    receiptRequest.current = id;
    setReceiptView({ticket});
    try {
      const receipt = await api('/orders/' + id);
      if (receiptRequest.current === id) setReceiptView({ticket, receipt});
    } catch {
      if (receiptRequest.current === id) setReceiptView({ticket, error: true});
    }
  }

  return <main className="kitchen-page">
    <div className="page-heading"><div><h1>Kitchen board<span className="green-dot">.</span></h1>
      <p>Track orders by station.</p></div>
      <div className={'connection ' + (disconnected ? 'offline' : '')} role="status">
        {disconnected ? <WifiOff size={17}/> : <span className="service-dot"/>}
        {disconnected ? 'Reconnecting…' : data ? 'Live · updates every 2s' : 'Connecting…'}
        <span className="kitchen-clock">{time(now)}</span>
      </div>
    </div>
    <div className="categories station-filters" aria-label="Kitchen stations">
      <button onClick={() => setStation('')} aria-pressed={!station}>All Stations</button>
      {Object.entries(stationNames).map(([id, label]) => <button key={id} aria-pressed={station === id}
        onClick={() => setStation(id)}>{label}</button>)}
    </div>
    <Problem>{problem}</Problem>
    {disconnected && <div className="notice reconnect"><WifiOff size={18}/>
      <span>Showing the last update at {time(last)}.</span><button type="button" onClick={() => refresh()}>Try again</button>
    </div>}
    {!data && !disconnected ? <div className="loading">Loading tickets…</div>
      : <div className="kitchen-columns">{statuses.map(([status, label]) => {
        const group = tickets.filter(ticket => ticket.status === status);
        return <section className={'kitchen-column ' + status} aria-label={label + ' tickets'} key={status}>
          <div className="column-heading"><h2><span className="status-dot"/>{label}<span>{group.length}</span></h2></div>
          <div className="ticket-list">{group.length ? group.map(ticket => <Ticket key={ticket.orderId} ticket={ticket}
            unavailable={disconnected} now={now} pending={pending} advance={advance} openReceipt={openReceipt} filtered={!!station}/>)
            : <div className="empty-column">{status === 'ready' ? <CheckCheck size={24}/> : <ChefHat size={24}/>}
              <p>No {label.toLowerCase()} tickets</p></div>}
          </div>
        </section>;
      })}</div>}
    {receiptView && <Dialog title={'Receipt #' + receiptView.ticket.ticketNumber} className="workspace-dialog" onClose={() => {
      receiptRequest.current = null;
      setReceiptView(null);
    }}>
      {receiptView.receipt ? <Receipt receipt={receiptView.receipt}/>
        : receiptView.error ? <Problem>Could not load the receipt.</Problem> : <p>Loading receipt…</p>}
    </Dialog>}
  </main>;
}
