import React, {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ShoppingBag, ChefHat, Package, ChartNoAxesCombined, Settings as SettingsIcon} from 'lucide-react';
import '@fontsource/geist/latin-400.css';
import '@fontsource/geist/latin-500.css';
import '@fontsource/geist/latin-600.css';
import '@fontsource/geist/latin-700.css';
import {Stone} from './art';
import {RestaurantMark, usePoll} from './workspace';
import {Cashier} from './cashier';
import {Kitchen} from './kitchen';
import {Inventory} from './inventory';
import {Sales} from './sales';
import {Settings} from './settings';
import './styles.css';
import './workspace.css';

const links = [
  ['cashier', 'Cashier', ShoppingBag, Cashier],
  ['kitchen', 'Kitchen', ChefHat, Kitchen],
  ['inventory', 'Inventory', Package, Inventory],
  ['sales', 'Sales', ChartNoAxesCombined, Sales],
  ['settings', 'Settings', SettingsIcon, Settings],
];
const defaultProfile = {name: 'Bite More', locationLabel: 'Buckhead · Atlanta, GA'};
const readPage = () => links.find(([key]) => key === location.pathname.slice(1))?.[0] ?? 'cashier';

function App() {
  const [page, setPage] = useState(readPage);
  const {data, error, refresh} = usePoll('/profile', 12000);
  const profile = data ?? defaultProfile;
  const [, label, , Screen] = links.find(([key]) => key === page);

  useEffect(() => {
    const pop = () => setPage(readPage());
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  useEffect(() => {
    document.title = 'Silaut · ' + label;
    document.documentElement.dataset.screen = page;
  }, [page, label]);

  function navigate(event, key) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    event.preventDefault();
    if (key === page) return;
    history.pushState({}, '', '/' + key);
    setPage(key);
    window.scrollTo(0, 0);
  }
  return <div className={'app ' + (page === 'kitchen' ? 'dark' : '')}>
    <header className="app-header workspace-header">
      <div className="workspace-identity">
        <a className="brand" href="/cashier" onClick={e => navigate(e, 'cashier')} aria-label="Silaut home">
          <Stone/><span>silaut<span className="brand-dot">.</span></span>
        </a>
        <div className="workspace-restaurant">
          <RestaurantMark restaurant={profile}/>
          <div><strong>{profile.name}</strong><span>{profile.locationLabel}</span></div>
        </div>
      </div>
      <nav aria-label="Main navigation">{links.map(([key, title, Icon]) =>
        <a href={'/' + key} key={key} className={page === key ? 'active' : ''} onClick={e => navigate(e, key)}
          aria-current={page === key ? 'page' : undefined}><Icon size={18}/><span>{title}</span></a>)}
      </nav>
      <div className="header-meta"><span className="service-dot"/>Demo workspace</div>
    </header>
    <Screen profile={data} profileError={error} refreshProfile={refresh}/>
  </div>;
}

createRoot(document.getElementById('root')).render(<App/>);
