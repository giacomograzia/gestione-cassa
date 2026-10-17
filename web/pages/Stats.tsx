import { useState } from 'react';
import type { Closure, Stats } from '../../shared/types';
import { euro, post, useLoad } from '../api';
import { useToast } from '../components/ui';

export function StatsPage({ isAdmin }: { isAdmin: boolean }) {
  const [scope, setScope] = useState<string>('open');
  const { data: stats, reload } = useLoad<Stats>(`/stats?closure=${scope}`, ['order']);
  const { data: closures, reload: reloadClosures } = useLoad<Closure[]>('/closures', ['order']);
  const toast = useToast();

  const close = async () => {
    if (!confirm('Chiudere la giornata? Le statistiche vengono archiviate e la numerazione degli ordini riparte da 1.')) return;
    try {
      const { id } = await post<{ id: number }>('/closures');
      toast('Giornata chiusa (backup salvato)');
      reloadClosures();
      setScope(String(id));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Statistiche</h1>
        <select value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Periodo">
          <option value="open">Giornata in corso</option>
          {closures?.map((c) => (
            <option key={c.id} value={c.id}>Chiusura del {c.createdAt.slice(0, 16)}</option>
          ))}
          <option value="all">Tutto lo storico</option>
        </select>
        <a className="button" href={`/api/stats.csv?closure=${scope}`}>Esporta CSV</a>
        <button onClick={reload}>Aggiorna</button>
        {isAdmin && scope === 'open' && (
          <button className="danger" onClick={close} disabled={!stats || stats.orders + stats.voidedOrders === 0}>Chiudi giornata</button>
        )}
      </div>

      {stats && (
        <>
          <div className="kpis">
            <div className="kpi"><span>Incasso netto</span><strong>{euro(stats.netCents)}</strong></div>
            <div className="kpi"><span>Ordini</span><strong>{stats.orders}</strong></div>
            <div className="kpi"><span>Scontrino medio</span><strong>{euro(stats.orders ? Math.round(stats.netCents / stats.orders) : 0)}</strong></div>
            <div className="kpi"><span>Sconti</span><strong>{euro(stats.discountCents)}</strong></div>
            <div className="kpi"><span>Omaggi (valore)</span><strong>{euro(stats.giftCents)}</strong></div>
            <div className="kpi"><span>Stornati</span><strong>{stats.voidedOrders}</strong></div>
          </div>

          <div className="stats-cols">
            <section>
              <h2>Per pagamento</h2>
              <table className="table compact">
                <tbody>
                  {stats.byPayment.map((r) => (
                    <tr key={r.method}><td>{r.method}</td><td className="num">{r.orders}</td><td className="num">{euro(r.cents)}</td></tr>
                  ))}
                </tbody>
              </table>
              <h2>Per operatore</h2>
              <table className="table compact">
                <tbody>
                  {stats.byOperator.map((r) => (
                    <tr key={r.operatorName}><td>{r.operatorName}</td><td className="num">{r.orders}</td><td className="num">{euro(r.cents)}</td></tr>
                  ))}
                </tbody>
              </table>
              <h2>Per famiglia</h2>
              <table className="table compact">
                <tbody>
                  {stats.byFamily.map((r) => (
                    <tr key={r.familyName}><td>{r.familyName}</td><td className="num">{r.qty}</td><td className="num">{euro(r.cents)}</td></tr>
                  ))}
                </tbody>
              </table>
            </section>
            <section>
              <h2>Venduto per prodotto</h2>
              <table className="table compact">
                <thead>
                  <tr><th>Famiglia</th><th>Prodotto</th><th className="num">Pz</th><th className="num">Omaggi</th><th className="num">Incasso</th></tr>
                </thead>
                <tbody>
                  {stats.byProduct.map((r) => (
                    <tr key={r.familyName + r.name}>
                      <td className="muted">{r.familyName}</td><td>{r.name}</td>
                      <td className="num">{r.qty}</td><td className="num">{r.gifts || ''}</td><td className="num">{euro(r.cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted small">I prodotti scelti nei menù compaiono con incasso 0: l'incasso è sulla riga del menù.</p>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
