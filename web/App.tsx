import { useEffect, useState } from 'react';
import type { Operator, Role } from '../shared/types';
import { ApiError, get, post, reconnectRealtime, useConnected, useRealtime } from './api';
import { useToast } from './components/ui';
import { Admin } from './pages/Admin';
import { Kitchen } from './pages/Kitchen';
import { Login, Setup } from './pages/Login';
import { Orders } from './pages/Orders';
import { Pos } from './pages/Pos';
import { StatsPage } from './pages/Stats';

const PAGES: { id: string; label: string; roles: Role[] }[] = [
  { id: 'cassa', label: 'Cassa', roles: ['admin', 'cassa'] },
  { id: 'cucina', label: 'Cucina', roles: ['admin', 'cassa', 'cucina'] },
  { id: 'ordini', label: 'Ordini', roles: ['admin', 'cassa'] },
  { id: 'statistiche', label: 'Statistiche', roles: ['admin', 'cassa'] },
  { id: 'admin', label: 'Gestione', roles: ['admin'] },
];

function useHashPage() {
  const read = () => location.hash.replace(/^#\/?/, '').split('/')[0];
  const [page, setPage] = useState(read);
  useEffect(() => {
    const on = () => setPage(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return page;
}

export function App() {
  const [state, setState] = useState<'loading' | 'setup' | 'login' | 'ready'>('loading');
  const [me, setMe] = useState<Operator | null>(null);
  const page = useHashPage();
  const toast = useToast();
  const online = useConnected();

  const refresh = async () => {
    try {
      setMe(await get<Operator>('/auth/me'));
      reconnectRealtime();
      setState('ready');
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) {
        toast('Server non raggiungibile', 'error');
        setTimeout(refresh, 3000);
        return;
      }
      const { needsSetup } = await get<{ needsSetup: boolean }>('/setup');
      setState(needsSetup ? 'setup' : 'login');
    }
  };
  useEffect(() => void refresh(), []);

  useRealtime((e) => {
    if (e.type === 'print-failed') toast(`Stampa non riuscita su "${e.printer}": ${e.error}`, 'error');
  });

  if (state === 'loading') return <div className="center-screen">Caricamento…</div>;
  if (state === 'setup') return <Setup onDone={refresh} />;
  if (state === 'login' || !me) return <Login onDone={refresh} />;

  const allowed = PAGES.filter((p) => p.roles.includes(me.role));
  const current = allowed.find((p) => p.id === page) ?? allowed[0];

  const logout = async () => {
    await post('/auth/logout');
    reconnectRealtime();
    setMe(null);
    setState('login');
  };

  return (
    <div className="app">
      <nav className="topbar">
        <div className="tabs">
          {allowed.map((p) => (
            <a key={p.id} href={`#/${p.id}`} className={p.id === current.id ? 'active' : ''}>{p.label}</a>
          ))}
        </div>
        <div className="who">
          {!online && <span className="badge danger" title="Gli aggiornamenti in tempo reale sono sospesi">Offline</span>}
          <span>{me.name}</span>
          <button className="ghost" onClick={logout}>Esci</button>
        </div>
      </nav>
      <main>
        {current.id === 'cassa' && <Pos />}
        {current.id === 'cucina' && <Kitchen />}
        {current.id === 'ordini' && <Orders isAdmin={me.role === 'admin'} />}
        {current.id === 'statistiche' && <StatsPage isAdmin={me.role === 'admin'} />}
        {current.id === 'admin' && <Admin />}
      </main>
    </div>
  );
}
