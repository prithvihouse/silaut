import React, {useCallback, useEffect, useRef, useState} from 'react';
import {X, AlertCircle} from 'lucide-react';
import {api} from './api';

export const money = cents => cents == null ? '—' : new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD',
}).format(cents / 100);

const eastern = {timeZone: 'America/New_York'};
export const time = value => value ? new Date(value).toLocaleTimeString('en-US', {
  ...eastern, hour: 'numeric', minute: '2-digit',
}) : '—';
export const timestamp = value => value ? new Date(value).toLocaleString('en-US', {
  ...eastern, dateStyle: 'medium', timeStyle: 'short',
}) : '—';
export const cutoffTime = minutes => new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC', hour: 'numeric', minute: '2-digit',
}).format(minutes * 60000);
export const stationNames = {grill: 'Grill', fryer: 'Fryer', pasta: 'Pasta', drinks: 'Drinks', prep: 'Prep', legacy: 'Legacy'};
export const modifierLabel = option => (option.instruction ?? option.label) + (option.demo ? ' (demo)' : '');

export function usePoll(path, interval = 2000) {
  const [view, setView] = useState({path: null, data: null, error: false, last: null});
  const active = useRef(null);
  const listening = useRef(null);
  const refresh = useCallback(async ({force = true} = {}) => {
    if (!path || listening.current !== path || (!force && active.current?.path === path)) return;
    const request = {path};
    active.current = request;
    try {
      const data = await api(path);
      if (active.current === request) setView({path, data, error: false, last: Date.now()});
    } catch {
      if (active.current === request) setView(old => ({
        path, data: old.path === path ? old.data : null, error: true, last: old.path === path ? old.last : null,
      }));
    } finally {
      if (active.current === request) active.current = null;
    }
  }, [path]);
  useEffect(() => {
    listening.current = path;
    refresh();
    const timer = setInterval(() => refresh({force: false}), interval);
    const visible = () => { if (!document.hidden) refresh({force: false}); };
    document.addEventListener('visibilitychange', visible);
    return () => {
      listening.current = null;
      active.current = null;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [path, refresh, interval]);
  return {...(view.path === path ? view : {data: null, error: false, last: null}), refresh};
}

export function Dialog({title, onClose, children, className = '', labelledClose}) {
  const dialog = useRef(null);
  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement;
    element.showModal();
    return () => {
      if (element.open) element.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return <dialog ref={dialog} aria-label={title} className={className}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="dialog-title">
      <h2>{title}</h2>
      <button type="button" aria-label={labelledClose || 'Close ' + title} className="icon-button" onClick={onClose}><X size={22}/></button>
    </div>
    {children}
  </dialog>;
}

export function Problem({children}) {
  return children ? <div className="notice warning" role="alert"><AlertCircle size={18}/><div>{children}</div></div> : null;
}

export function RestaurantMark({restaurant}) {
  return restaurant.logoUrl
    ? <img className="restaurant-mark" src={restaurant.logoUrl} alt=""/>
    : <span className="restaurant-mark" aria-hidden="true">{restaurant.name.split(/\s+/).slice(0, 2).map(part => Array.from(part)[0]).join('').toUpperCase()}</span>;
}

export function Receipt({receipt, sent = false}) {
  const restaurant = receipt.restaurant ?? {name: 'Silaut'};
  return <div className="receipt-document">
    <div className="receipt-identity">
      <RestaurantMark restaurant={restaurant}/>
      <div><strong>{restaurant.name}</strong>
        {restaurant.locationLabel && <div>{restaurant.locationLabel}</div>}
        {restaurant.address && <small>{restaurant.address}</small>}
      </div>
    </div>
    <p className="receipt-powered">Powered by Silaut</p>
    <div className="receipt-summary"><strong>Order #{receipt.ticketNumber}{sent && ' sent'}</strong>
      <span>{money(receipt.totalCents)}</span>
    </div>
    <ul className="receipt-list">{receipt.items.map((item, index) =>
      <li key={item.lineNo ?? index}>
        <span>{item.quantity} × {item.name}
          {item.modifiers?.length > 0 && <small>{item.modifiers.map(option =>
            modifierLabel(option) + (option.priceDeltaCents ? ' (' + money(option.priceDeltaCents) + ')' : '')).join(' · ')}</small>}
        </span>
        <span>{money(item.lineTotalCents)}</span>
      </li>)}</ul>
    <small>{timestamp(receipt.createdAt)} · Simulated checkout</small>
  </div>;
}
