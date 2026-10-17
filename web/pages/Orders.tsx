import { useState } from 'react';
import type { Order } from '../../shared/types';
import { euro, post, useLoad } from '../api';
import { Field, Modal, useToast } from '../components/ui';

interface PrintJob {
  id: number;
  createdAt: string;
  kind: string;
  status: 'pending' | 'done' | 'failed';
  error: string | null;
  orderId: number | null;
  printer: string;
}

export function Orders({ isAdmin }: { isAdmin: boolean }) {
  const { data: orders, reload } = useLoad<Order[]>('/orders', ['order']);
  const { data: jobs, reload: reloadJobs } = useLoad<PrintJob[]>('/print-jobs', ['order', 'print-failed']);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<Order | null>(null);
  const toast = useToast();

  const failed = jobs?.filter((j) => j.status === 'failed') ?? [];
  const filtered = (orders ?? []).filter(
    (o) => !search || String(o.number) === search.trim() || o.tableLabel.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="page">
      <div className="page-head">
        <h1>Ordini della giornata</h1>
        <input placeholder="Cerca numero o tavolo" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {failed.length > 0 && (
        <div className="alert">
          <strong>{failed.length} stampe non riuscite.</strong> Controlla che la stampante sia accesa e collegata, poi ristampa.
          <ul>
            {failed.map((j) => (
              <li key={j.id}>
                {j.createdAt.slice(11, 16)} · {j.printer} · {j.kind} — {j.error}{' '}
                <button
                  className="link"
                  onClick={async () => {
                    await post(`/print-jobs/${j.id}/retry`);
                    setTimeout(reloadJobs, 1500);
                  }}
                >
                  Ristampa
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <table className="table">
        <thead>
          <tr>
            <th>N.</th><th>Ora</th><th>Tavolo/Nome</th><th>Operatore</th><th>Pagamento</th><th className="num">Totale</th><th />
          </tr>
        </thead>
        <tbody>
          {filtered.map((o) => (
            <tr key={o.id} className={o.status === 'voided' ? 'voided' : ''} onClick={() => setOpen(o)}>
              <td><strong>{o.number}</strong></td>
              <td>{o.createdAt.slice(11, 16)}</td>
              <td>{o.takeaway ? 'Asporto ' : ''}{o.tableLabel}</td>
              <td>{o.operatorName}</td>
              <td>{o.paymentMethod}</td>
              <td className="num">{euro(o.totalCents)}</td>
              <td>{o.status === 'voided' && <span className="badge danger">stornato</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {orders?.length === 0 && <p className="muted">Ancora nessun ordine.</p>}

      {open && (
        <OrderDetail
          order={open}
          isAdmin={isAdmin}
          onClose={() => setOpen(null)}
          onChanged={(o) => {
            setOpen(o);
            reload();
          }}
          toast={toast}
        />
      )}
    </div>
  );
}

function OrderDetail(props: {
  order: Order;
  isAdmin: boolean;
  onClose: () => void;
  onChanged: (o: Order) => void;
  toast: ReturnType<typeof useToast>;
}) {
  const o = props.order;
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const top = o.lines.filter((l) => l.parentLineId === null);

  const reprint = async (what: 'receipt' | 'comande' | 'all') => {
    try {
      await post(`/orders/${o.id}/reprint`, { what });
      props.toast('Ristampa inviata');
    } catch (e) {
      props.toast((e as Error).message, 'error');
    }
  };
  const doVoid = async () => {
    try {
      props.onChanged(await post<Order>(`/orders/${o.id}/void`, { reason }));
      setVoiding(false);
      props.toast('Ordine stornato');
    } catch (e) {
      props.toast((e as Error).message, 'error');
    }
  };

  return (
    <Modal title={`Ordine n. ${o.number}`} onClose={props.onClose}>
      <p className="muted">
        {o.createdAt} · {o.operatorName} · {o.takeaway ? 'Asporto · ' : ''}{o.tableLabel || 'senza tavolo'}
      </p>
      {o.status === 'voided' && (
        <div className="alert">Stornato il {o.voidedAt}: {o.voidReason}</div>
      )}
      <ul className="detail-lines">
        {top.map((l) => (
          <li key={l.id}>
            <span>{l.qty} × {l.name}{l.gift && <span className="badge">omaggio</span>}</span>
            <span>{l.gift ? '—' : euro(l.qty * l.unitPriceCents)}</span>
            {o.lines.filter((s) => s.parentLineId === l.id).map((s) => (
              <small key={s.id} className="muted sub">{s.qty} {s.name}</small>
            ))}
            {l.note && <small className="note sub">* {l.note}</small>}
          </li>
        ))}
      </ul>
      <div className="totals">
        {o.discountCents > 0 && <div><span>Sconto</span><span>−{euro(o.discountCents)}</span></div>}
        <div className="grand"><span>Totale</span><span>{euro(o.totalCents)}</span></div>
        <div><span>{o.paymentMethod}</span><span>{euro(o.paidCents)}</span></div>
      </div>
      {o.note && <p>Note: {o.note}</p>}

      {o.status === 'ok' && !voiding && (
        <div className="row-actions wrap">
          <button onClick={() => reprint('receipt')}>Ristampa scontrino</button>
          <button onClick={() => reprint('comande')}>Ristampa comande</button>
          {o.closureId === null && <button className="danger" onClick={() => setVoiding(true)}>Storna…</button>}
        </div>
      )}
      {voiding && (
        <>
          <Field label="Motivo dello storno" hint="Il magazzino viene ripristinato e la cucina avvisata.">
            <input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus maxLength={200} />
          </Field>
          <div className="row-actions">
            <button onClick={() => setVoiding(false)}>Annulla</button>
            <button className="danger" disabled={!reason.trim()} onClick={doVoid}>Conferma storno</button>
          </div>
        </>
      )}
    </Modal>
  );
}
