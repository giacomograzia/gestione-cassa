import { useEffect, useRef, useState } from 'react';
import type { Catalog, Order } from '../../shared/types';
import { post, useLoad, useLocalStorage } from '../api';
import { useToast } from '../components/ui';

/** Minuti trascorsi da un timestamp locale "YYYY-MM-DD HH:MM:SS". */
function minutesSince(ts: string, now: number) {
  const t = new Date(ts.replace(' ', 'T')).getTime();
  return Math.max(0, Math.floor((now - t) / 60000));
}

function beep() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  } catch {
    /* audio non disponibile */
  }
}

export function Kitchen() {
  const { data: catalog } = useLoad<Catalog>('/catalog', ['catalog']);
  const [stationId, setStationId] = useLocalStorage<number | null>('cucina.station', null);
  const [sound, setSound] = useLocalStorage('cucina.sound', true);
  const { data: orders, reload } = useLoad<Order[]>(stationId ? `/kitchen?station=${stationId}` : null, ['kitchen']);
  const [now, setNow] = useState(Date.now());
  const seen = useRef<Set<number> | null>(null);
  const toast = useToast();

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  // suono quando arriva un ordine nuovo
  useEffect(() => {
    if (!orders) return;
    const ids = new Set(orders.map((o) => o.id));
    if (seen.current && sound && orders.some((o) => !seen.current!.has(o.id))) beep();
    seen.current = ids;
  }, [orders]);
  useEffect(() => {
    seen.current = null;
  }, [stationId]);

  if (!catalog) return <div className="center-screen">Caricamento…</div>;
  const stations = catalog.stations.filter((s) => s.enabled);
  const station = stations.find((s) => s.id === stationId);

  if (!station) {
    return (
      <div className="center-screen">
        <div className="card login">
          <h1>Quale reparto?</h1>
          {stations.length === 0 && <p className="muted">Nessun reparto configurato: aggiungilo da Gestione → Reparti.</p>}
          <div className="operator-grid">
            {stations.map((s) => (
              <button key={s.id} className="big" onClick={() => setStationId(s.id)}>{s.name}</button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="kitchen">
      <div className="kitchen-head">
        <h1>{station.name}</h1>
        <span className="muted">{orders ? `${orders.length} ordini aperti` : ''}</span>
        <div className="spacer" />
        <label className="check">
          <input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} /> Suono
        </label>
        <button className="ghost" onClick={() => setStationId(null)}>Cambia reparto</button>
      </div>
      <div className="kitchen-grid">
        {orders?.map((o) => {
          const lines = o.lines.filter((l) => l.stationId === station.id && l.kitchenStatus !== 'delivered');
          const allReady = lines.every((l) => l.kitchenStatus === 'ready');
          const age = minutesSince(o.createdAt, now);
          return (
            <article key={o.id} className={`ticket ${allReady ? 'ready' : age >= 20 ? 'late' : age >= 10 ? 'warn' : ''}`}>
              <header>
                <span className="ticket-number">{o.number}</span>
                <span className="ticket-tag">{o.takeaway ? 'ASPORTO ' : ''}{o.tableLabel}</span>
                <span className="ticket-age">{age}′</span>
              </header>
              <ul>
                {lines.map((l) => {
                  const menu = o.lines.find((m) => m.id === l.parentLineId);
                  return (
                    <li key={l.id}>
                      <button
                        className={l.kitchenStatus === 'ready' ? 'done' : ''}
                        onClick={() => act(() => post(`/kitchen/lines/${l.id}`, { status: l.kitchenStatus === 'ready' ? 'pending' : 'ready' }))}
                      >
                        <strong>{l.qty}×</strong> {l.name}
                        {menu && <small> ({menu.name})</small>}
                        {l.note && <em>* {l.note}</em>}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {o.note && <p className="ticket-note">NOTE: {o.note}</p>}
              <footer>
                {allReady ? (
                  <button className="primary" onClick={() => act(() => post(`/kitchen/orders/${o.id}`, { station: station.id, status: 'delivered' }))}>
                    Consegnato
                  </button>
                ) : (
                  <button onClick={() => act(() => post(`/kitchen/orders/${o.id}`, { station: station.id, status: 'ready' }))}>
                    Tutto pronto
                  </button>
                )}
              </footer>
            </article>
          );
        })}
        {orders?.length === 0 && <p className="muted empty-kitchen">Nessun ordine da preparare 🎉</p>}
      </div>
    </div>
  );
}
