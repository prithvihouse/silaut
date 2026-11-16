import React, {useEffect, useRef, useState} from 'react';
import {ArrowRight, ChevronUp, Plus, Minus, Search, ShoppingBag, SlidersHorizontal, WifiOff, X} from 'lucide-react';
import {api} from './api';
import {MenuArt} from './art';
import {Dialog, Problem, Receipt, money, usePoll} from './workspace';

const CART_KEY = 'silaut.cart.v1';
const emptyCart = () => ({lines: [], orderId: null, pending: false});
const lineKey = line => line.itemId + ':' + (line.modifiers ?? []).join(',');
function readCart() {
  try {
    const cart = JSON.parse(localStorage.getItem(CART_KEY));
    if (cart && Array.isArray(cart.lines)) return cart;
  } catch { /* An invalid stored draft should not prevent checkout. */ }
  return emptyCart();
}

function ItemEditor({item, current, onApply, onClose}) {
  const groups = item.modifierGroups;
  const [selected, setSelected] = useState(() => current?.modifiers ?? groups.flatMap(group =>
    group.options.filter(option => option.default).map(option => option.key)));
  const options = groups.flatMap(group => group.options).filter(option => selected.includes(option.key));
  const total = item.priceCents + options.reduce((sum, option) => sum + option.priceDeltaCents, 0);
  const valid = total >= 0 && groups.every(group => {
    const count = group.options.filter(option => selected.includes(option.key)).length;
    return count >= group.min && count <= group.max;
  });

  function choose(group, key, checked) {
    if (group.max === 1) {
      const otherGroups = selected.filter(value => !group.options.some(option => option.key === value));
      setSelected(checked ? [...otherGroups, key] : otherGroups);
      return;
    }
    setSelected(checked ? [...selected, key] : selected.filter(value => value !== key));
  }

  return <Dialog title={item.name} onClose={onClose} className="editor-dialog">
    <form onSubmit={event => {
      event.preventDefault();
      if (valid) onApply({itemId: item.itemId, name: item.name, unitPriceCents: total,
        quantity: current?.quantity ?? 1, modifiers: [...selected].sort(),
        modifierLabels: options.map(option => option.label + (option.demo ? ' (demo)' : ''))});
    }}>
      <p className="editor-base">{item.description} <strong>{money(item.priceCents)} base</strong></p>
      {groups.map(group => {
        const count = group.options.filter(option => selected.includes(option.key)).length;
        return <fieldset className="modifier-group" key={group.key}>
          <legend>{group.label}</legend>
          <p>{group.min === 0 ? 'Optional' : group.min === group.max ? 'Choose ' + group.min : 'Choose at least ' + group.min}
            {group.min !== group.max && ' · Up to ' + group.max}</p>
          <div className="modifier-options">{group.options.map(option => {
            const checked = selected.includes(option.key);
            const singleRequired = group.min === 1 && group.max === 1;
            return <label className={'option-tile' + (checked ? ' checked' : '')} key={option.key}>
              <input type={singleRequired ? 'radio' : 'checkbox'} name={group.key} checked={checked}
                disabled={group.max > 1 && count >= group.max && !checked}
                onChange={e => choose(group, option.key, e.target.checked)}/>
              <span>{option.label}{option.demo && <small>Demo option</small>}</span>
              {option.priceDeltaCents !== 0 && <strong>{option.priceDeltaCents > 0 ? '+' : '−'}{money(Math.abs(option.priceDeltaCents))}</strong>}
            </label>;
          })}</div>
        </fieldset>;
      })}
      <div className="editor-actions"><button type="submit" className="primary" disabled={!valid}>
        {current ? 'Update item' : 'Add to order'} <strong>{money(total * (current?.quantity ?? 1))}</strong>
      </button></div>
    </form>
  </Dialog>;
}

export function Cashier() {
  const {data, error, refresh} = usePoll('/catalog', 4000);
  const [cart, setCart] = useState(readCart);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [category, setCategory] = useState('');
  const [query, setQuery] = useState('');
  const [sheet, setSheet] = useState(false);
  const [editor, setEditor] = useState(null);
  const [mobileReceipt, setMobileReceipt] = useState(false);
  const sendLock = useRef(false);
  const items = data?.items ?? [];
  const categories = [...new Set(items.map(item => item.category))];
  const search = query.trim().toLowerCase();
  const filtered = items.filter(item => (!category || item.category === category)
    && [item.name, item.category, item.portion].some(value => value?.toLowerCase().includes(search)));
  const count = cart.lines.reduce((sum, line) => sum + line.quantity, 0);
  const total = cart.lines.reduce((sum, line) => sum + line.quantity * line.unitPriceCents, 0);
  const locked = busy || cart.pending;
  const provenance = items.find(item => item.priceChannel);

  useEffect(() => {
    const sync = event => { if (event.key === CART_KEY && !sendLock.current) setCart(readCart()); };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  function save(next) {
    localStorage.setItem(CART_KEY, JSON.stringify(next));
    setCart(next);
  }

  function changeLine(line, delta, replacing = null) {
    if (locked) return;
    const key = lineKey(line);
    const other = cart.lines.filter(value => lineKey(value) !== replacing);
    const previous = other.find(value => lineKey(value) === key);
    const quantity = (previous?.quantity ?? 0) + delta;
    const lines = other.filter(value => lineKey(value) !== key);
    if (quantity > 0) lines.push({...line, quantity});
    lines.sort((a, b) => a.itemId - b.itemId || lineKey(a).localeCompare(lineKey(b)));
    save({...emptyCart(), lines});
    setReceipt(null);
    setMessage(null);
  }

  function add(item) {
    if (item.modifierGroups?.length) setEditor({item});
    else changeLine({itemId: item.itemId, name: item.name, unitPriceCents: item.priceCents}, 1);
  }

  async function send() {
    if (!cart.lines.length || sendLock.current) return;
    setBusy(true);
    sendLock.current = true;
    setMessage(null);
    const attempt = {...cart, orderId: cart.orderId ?? crypto.randomUUID(), pending: true};
    try {
      save(attempt);
      const result = await api('/orders', {method: 'POST', body: JSON.stringify({
        orderId: attempt.orderId,
        items: attempt.lines.map(({itemId, quantity, modifiers}) => ({itemId, quantity, modifiers})),
      })});
      setReceipt(result);
      setMobileReceipt(true);
      setSheet(false);
      save(emptyCart());
      await refresh();
    } catch (failure) {
      if ([400, 404, 409, 413, 415].includes(failure.status) && failure.body?.code !== 'ORDER_ID_CONFLICT') {
        save({...attempt, orderId: null, pending: false});
        const shortages = failure.body?.shortages;
        setMessage({
          title: shortages ? 'Stock changed. Adjust this order.' : 'Review items in this order.',
          detail: shortages?.map(s => s.name + ': ' + s.onHand + ' ' + s.unit + ' available, ' + s.required + ' needed.').join(' ')
            ?? 'An item or selection may have changed. Review the cart before sending.',
          itemIds: shortages?.flatMap(s => s.itemIds) ?? [],
        });
        refresh();
      } else {
        setMessage({title: 'Order not confirmed yet.', detail: 'Retry the saved order to check whether it went through.'});
      }
    } finally {
      sendLock.current = false;
      setBusy(false);
    }
  }

  const cartContent = <>
    <div className="cart-heading"><h2>Current order <span className="count-bubble">{count}</span></h2><ShoppingBag size={22}/></div>
    <div className="cart-body">
      {receipt && <section className="cart-receipt" role="status"><Receipt receipt={receipt} sent/></section>}
      {message && <Problem><strong>{message.title}</strong><p>{message.detail}</p></Problem>}
      {!cart.lines.length && !receipt && <div className="cart-empty"><ShoppingBag size={30}/><h3>Your cart is empty</h3><p>Choose an item to start an order.</p></div>}
      {cart.lines.length > 0 && <div className="cart-lines">{cart.lines.map(line => {
        const item = items.find(entry => entry.itemId === line.itemId);
        const needsChange = message?.itemIds?.includes(line.itemId);
        return <div className={'cart-line' + (needsChange ? ' needs-change' : '')} key={lineKey(line)}>
          <div className="line-top"><strong>{line.name}</strong><span>{money(line.unitPriceCents * line.quantity)}</span></div>
          {line.modifierLabels?.length > 0 && <p className="line-modifiers">{line.modifierLabels.join(' · ')}</p>}
          <div className="line-bottom">
            {item?.modifierGroups.length
              ? <button className="text-button" disabled={locked} onClick={() => setEditor({item, current: line})}>Edit options</button>
              : <span>{money(line.unitPriceCents)} each</span>}
            <div className="stepper">
              <button aria-label={'Remove one ' + line.name} disabled={locked} onClick={() => changeLine(line, -1)}><Minus size={16}/></button>
              <span aria-label={line.name + ' quantity'}>{line.quantity}</span>
              <button aria-label={'Add one ' + line.name} disabled={locked} onClick={() => changeLine(line, 1)}><Plus size={16}/></button>
            </div>
          </div>
          {needsChange && <small className="line-warning">Ingredient shortage</small>}
        </div>;
      })}</div>}
    </div>
    <div className="cart-footer">
      <div className="subtotal"><span>Subtotal</span><span>{money(total)}</span></div>
      <p className="demo-note">Simulated checkout · no payment collected</p>
      <button className="primary send-button" disabled={!count || busy} onClick={send}>
        <span>{busy ? 'Sending…' : cart.pending ? 'Retry same order' : 'Send to kitchen'}</span><span>{money(total)} <ArrowRight size={19}/></span>
      </button>
    </div>
  </>;
  return <main className="cashier-layout">
    <section className="menu-section">
      <div className="page-heading">
        <div><h1>Cashier<span className="green-dot">.</span></h1>
          {provenance && <p className="price-provenance">{provenance.priceChannel} · checked {provenance.priceCheckedOn}</p>}</div>
      </div>
      {receipt && mobileReceipt && <section className="cashier-mobile-receipt">
        <button type="button" className="icon-button" aria-label="Dismiss receipt" onClick={() => setMobileReceipt(false)}><X size={19}/></button>
        <Receipt receipt={receipt} sent/>
      </section>}
      <div className="menu-toolbar"><label className="search"><Search size={18}/>
        <input aria-label="Search menu" placeholder="Search menu" value={query} onChange={e => setQuery(e.target.value)}/>
      </label></div>
      <div className="categories menu-filters" aria-label="Menu categories">
        <button aria-pressed={!category} onClick={() => setCategory('')}>All items</button>
        {categories.map(name => <button aria-pressed={category === name} onClick={() => setCategory(name)} key={name}>{name}</button>)}
      </div>
      {error && <div className="notice warning" role="status"><WifiOff size={18}/> Reconnecting to the menu…</div>}
      {!data && !error && <div className="loading">Loading the menu…</div>}
      <div className="menu-grid expanded-menu">{filtered.map(item => {
        const configurable = item.modifierGroups?.length > 0;
        const selected = cart.lines.filter(line => line.itemId === item.itemId).reduce((sum, line) => sum + line.quantity, 0);
        const unavailable = !!item.unavailableReason;
        return <button className={'menu-tile' + (selected ? ' in-cart' : '') + (!item.available ? ' sold-out' : '')}
          key={item.itemId} disabled={locked || unavailable || (!item.available && !configurable)}
          onClick={() => add(item)} aria-label={(configurable ? 'Customize ' : 'Add ') + item.name}>
          <div className="tile-art"><MenuArt category={item.category}/>
            {selected > 0 && <span className="selected-quantity">{selected} in order</span>}</div>
          <div className="tile-content"><h3>{item.name}</h3><p>{item.portion && <b>{item.portion} · </b>}{item.description}</p>
            {item.priceChannel && item.priceChannel !== provenance?.priceChannel &&
              <small className="item-provenance">{item.priceChannel}</small>}
            <div className="tile-bottom"><strong>{unavailable ? 'Unavailable' : money(item.priceCents)}</strong>
              {!unavailable && <span className="tile-add">{configurable ? <SlidersHorizontal size={17}/> : <Plus size={19}/>}</span>}</div>
            <div className={'availability ' + (!item.available ? 'out' : item.sellableUnits <= 5 ? 'low' : '')}>
              <span/>{item.unavailableReason ?? (item.available ? item.sellableUnits + ' available' : configurable ? 'Default sold out' : 'Sold out')}
            </div>
          </div>
        </button>;
      })}</div>
      {data && !filtered.length && <div className="empty-state"><Search/><h3>No matching items</h3><p>Change the search or category.</p></div>}
    </section>
    <aside className="desktop-cart" aria-label="Current order">{cartContent}</aside>
    <button className="mobile-cart-summary primary" onClick={() => setSheet(true)} aria-haspopup="dialog">
      <span><ShoppingBag size={20}/> View order <b>{count}</b></span><span>{money(total)} <ChevronUp size={20}/></span>
    </button>
    {sheet && <Dialog title="Current order" labelledClose="Close order" className="cart-dialog v2-cart-dialog"
      onClose={() => setSheet(false)}>{cartContent}</Dialog>}
    {editor && <ItemEditor {...editor} onClose={() => setEditor(null)} onApply={line => {
      changeLine(line, line.quantity, editor.current ? lineKey(editor.current) : null);
      setEditor(null);
    }}/>}
  </main>;
}
