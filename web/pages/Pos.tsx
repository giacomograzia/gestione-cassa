import { useEffect, useMemo, useState } from 'react';
import type { Catalog, Menu, NewOrder, Order, PaymentMethod, Product, Settings, Till } from '../../shared/types';
import { euro, get, parseEuro, post, useLoad, useLocalStorage } from '../api';
import { Field, Keypad, Modal, useToast } from '../components/ui';

type CartLine =
  | { key: number; kind: 'product'; productId: number; qty: number; gift: boolean; note: string; priceCents?: number }
  | {
      key: number;
      kind: 'menu';
      menuId: number;
      qty: number;
      gift: boolean;
      note: string;
      components: { componentId: number; productIds: number[] }[];
    };

let nextKey = 1;

/** Nero o bianco, quello più leggibile sopra il colore indicato. */
function textOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#111' : '#fff';
}

/** Unità di magazzino consumate dal carrello, per chiave "p:<prodotto>" o "s:<magazzino>". */
function cartConsumption(cart: CartLine[], products: Map<number, Product>) {
  const used = new Map<string, number>();
  const add = (p: Product | undefined, pieces: number) => {
    if (!p || p.stockMode === 'unlimited') return;
    const key = p.stockMode === 'own' ? `p:${p.id}` : `s:${p.storageId}`;
    used.set(key, (used.get(key) ?? 0) + pieces * p.stockUnits);
  };
  for (const l of cart) {
    if (l.kind === 'product') add(products.get(l.productId), l.qty);
    else for (const c of l.components) for (const pid of c.productIds) add(products.get(pid), l.qty);
  }
  return used;
}

function remaining(p: Product, catalog: Catalog, used: Map<string, number>): number | null {
  if (p.stockMode === 'unlimited') return null;
  const key = p.stockMode === 'own' ? `p:${p.id}` : `s:${p.storageId}`;
  const base = p.stockMode === 'own' ? p.stockQty : catalog.storages.find((s) => s.id === p.storageId)?.quantity ?? 0;
  return Math.max(0, Math.floor((base - (used.get(key) ?? 0)) / p.stockUnits + 1e-9));
}

export function Pos() {
  const { data: catalog } = useLoad<Catalog>('/catalog', ['catalog', 'stock']);
  const { data: settings } = useLoad<Settings>('/settings', ['catalog']);
  const [tills, setTills] = useState<Till[] | null>(null);
  const [tillId, setTillId] = useLocalStorage<number | null>('cassa.till', null);
  const [familySel, setFamilySel] = useState<number | 'menu' | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [tableLabel, setTableLabel] = useState('');
  const [takeaway, setTakeaway] = useState(false);
  const [orderNote, setOrderNote] = useState('');
  const [discount, setDiscount] = useState<NewOrder['discount']>();
  const [modal, setModal] = useState<
    | { t: 'price'; product: Product }
    | { t: 'menu'; menu: Menu }
    | { t: 'line'; key: number }
    | { t: 'discount' }
    | { t: 'pay' }
    | null
  >(null);
  const [last, setLast] = useState<Order | null>(null);
  const toast = useToast();

  useEffect(() => {
    get<Till[]>('/tills').then(setTills).catch((e) => toast(e.message, 'error'));
  }, []);

  const products = useMemo(() => new Map((catalog?.products ?? []).map((p) => [p.id, p])), [catalog]);
  const used = useMemo(() => cartConsumption(cart, products), [cart, products]);

  if (!catalog || !settings || !tills) return <div className="center-screen">Caricamento…</div>;

  const till = tills.find((t) => t.id === tillId);
  if (!till) {
    return (
      <div className="center-screen">
        <div className="card login">
          <h1>Scegli la postazione</h1>
          {tills.length === 0 && <p className="muted">Nessuna postazione configurata: aggiungila da Gestione → Casse.</p>}
          <div className="operator-grid">
            {tills.map((t) => (
              <button key={t.id} className="big" onClick={() => setTillId(t.id)}>{t.name}</button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const families = catalog.families.filter((f) => f.visible);
  const menus = catalog.menus.filter((m) => m.visible && m.components.length > 0);
  const activeFamily = familySel ?? (menus.length ? 'menu' : families[0]?.id ?? null);
  const shown =
    activeFamily === 'menu'
      ? []
      : catalog.products.filter((p) => p.familyId === activeFamily && p.visible && !p.menuOnly);

  const addProduct = (p: Product, priceCents?: number) => {
    setLast(null);
    setCart((c) => {
      const same = c.find(
        (l) => l.kind === 'product' && l.productId === p.id && !l.gift && !l.note && l.priceCents === priceCents,
      );
      if (same) return c.map((l) => (l === same ? { ...l, qty: l.qty + 1 } : l));
      return [...c, { key: nextKey++, kind: 'product', productId: p.id, qty: 1, gift: false, note: '', priceCents }];
    });
  };

  const onProduct = (p: Product) => {
    if (p.priceCents === null) setModal({ t: 'price', product: p });
    else addProduct(p);
  };

  const unitPrice = (l: CartLine) =>
    l.kind === 'menu'
      ? catalog.menus.find((m) => m.id === l.menuId)?.priceCents ?? 0
      : l.priceCents ?? products.get(l.productId)?.priceCents ?? 0;
  const lineName = (l: CartLine) =>
    l.kind === 'menu' ? catalog.menus.find((m) => m.id === l.menuId)?.name ?? '?' : products.get(l.productId)?.name ?? '?';

  const subtotal = cart.reduce((s, l) => s + (l.gift ? 0 : l.qty * unitPrice(l)), 0);
  const discountCents = !discount
    ? 0
    : discount.type === 'percent'
      ? Math.round((subtotal * discount.value) / 100)
      : Math.min(discount.value, subtotal);
  const total = subtotal - discountCents;

  const updateLine = (key: number, patch: Partial<CartLine> | null) =>
    setCart((c) =>
      patch === null ? c.filter((l) => l.key !== key) : c.map((l) => (l.key === key ? ({ ...l, ...patch } as CartLine) : l)),
    );

  const reset = () => {
    setCart([]);
    setTableLabel('');
    setTakeaway(false);
    setOrderNote('');
    setDiscount(undefined);
  };

  const submit = async (method: PaymentMethod, paidCents: number) => {
    const order: NewOrder = {
      tillId: till.id,
      tableLabel,
      takeaway,
      note: orderNote,
      discount,
      payment: { method, paidCents },
      lines: cart.map((l) =>
        l.kind === 'product'
          ? { productId: l.productId, qty: l.qty, gift: l.gift, note: l.note, priceCents: l.priceCents }
          : { menuId: l.menuId, qty: l.qty, gift: l.gift, note: l.note, components: l.components },
      ),
    };
    try {
      const created = await post<Order>('/orders', order);
      setModal(null);
      setLast(created);
      reset();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const needsTable = settings.requireTable && !tableLabel.trim() && !takeaway;

  return (
    <div className="pos">
      <section className="pos-catalog">
        <div className="family-tabs">
          {menus.length > 0 && (
            <button className={activeFamily === 'menu' ? 'active' : ''} onClick={() => setFamilySel('menu')} style={{ ['--c' as string]: '#7c5cff' }}>
              Menù
            </button>
          )}
          {families.map((f) => (
            <button key={f.id} className={activeFamily === f.id ? 'active' : ''} onClick={() => setFamilySel(f.id)} style={{ ['--c' as string]: f.color, ['--on-c' as string]: textOn(f.color) }}>
              {f.name}
            </button>
          ))}
        </div>
        <div className="product-grid">
          {activeFamily === 'menu' &&
            menus.map((m) => {
              const soldOut = m.components.some((c) =>
                c.productIds.every((pid) => {
                  const p = products.get(pid);
                  return !p || remaining(p, catalog, used) === 0;
                }),
              );
              return (
                <button key={m.id} className="product" disabled={soldOut} style={{ ['--c' as string]: m.color }} onClick={() => setModal({ t: 'menu', menu: m })}>
                  <span className="name">{m.name}</span>
                  <span className="price">{euro(m.priceCents)}</span>
                  {soldOut && <span className="stock out">Esaurito</span>}
                </button>
              );
            })}
          {shown.map((p) => {
            const left = remaining(p, catalog, used);
            const color = catalog.families.find((f) => f.id === p.familyId)?.color;
            return (
              <button key={p.id} className="product" disabled={left === 0} style={{ ['--c' as string]: color }} onClick={() => onProduct(p)}>
                <span className="name">{p.name}</span>
                <span className="price">{p.priceCents === null ? 'Prezzo libero' : euro(p.priceCents)}</span>
                {left !== null && (
                  <span className={`stock ${left === 0 ? 'out' : left <= p.lowStock ? 'low' : ''}`}>
                    {left === 0 ? 'Esaurito' : `${left} rimasti`}
                  </span>
                )}
              </button>
            );
          })}
          {activeFamily !== 'menu' && shown.length === 0 && <p className="muted">Nessun prodotto in questa famiglia.</p>}
        </div>
      </section>

      <aside className="pos-cart">
        <div className="cart-head">
          <input
            placeholder="Tavolo o nome"
            value={tableLabel}
            onChange={(e) => setTableLabel(e.target.value)}
            maxLength={40}
            aria-label="Tavolo o nome"
          />
          <button className={takeaway ? 'toggle on' : 'toggle'} onClick={() => setTakeaway(!takeaway)} aria-pressed={takeaway}>
            Asporto
          </button>
        </div>

        {last && cart.length === 0 && (
          <div className="last-order">
            <div className="muted">Ordine registrato</div>
            <div className="last-number">n. {last.number}</div>
            {last.paymentMethod === 'contanti' && last.paidCents > last.totalCents && (
              <div className="change">Resto {euro(last.paidCents - last.totalCents)}</div>
            )}
          </div>
        )}

        <ul className="cart-lines">
          {cart.map((l) => (
            <li key={l.key}>
              <button className="line-main" onClick={() => setModal({ t: 'line', key: l.key })}>
                <span className="line-name">
                  {lineName(l)}
                  {l.gift && <span className="badge">omaggio</span>}
                </span>
                {l.kind === 'menu' && (
                  <small className="muted">
                    {l.components.flatMap((c) => c.productIds.map((pid) => products.get(pid)?.name)).join(', ')}
                  </small>
                )}
                {l.note && <small className="note">* {l.note}</small>}
              </button>
              <div className="qty">
                <button onClick={() => updateLine(l.key, l.qty > 1 ? { qty: l.qty - 1 } : null)} aria-label="Togli uno">−</button>
                <span>{l.qty}</span>
                <button onClick={() => updateLine(l.key, { qty: l.qty + 1 })} aria-label="Aggiungi uno">+</button>
              </div>
              <span className="line-total">{l.gift ? '—' : euro(l.qty * unitPrice(l))}</span>
            </li>
          ))}
          {cart.length === 0 && !last && <li className="muted empty">Tocca un prodotto per iniziare</li>}
        </ul>

        <div className="cart-foot">
          <input placeholder="Nota per la cucina" value={orderNote} onChange={(e) => setOrderNote(e.target.value)} maxLength={200} />
          <div className="totals">
            {discountCents > 0 && (
              <>
                <div><span>Subtotale</span><span>{euro(subtotal)}</span></div>
                <div><span>Sconto {discount?.type === 'percent' ? `${discount.value}%` : ''}</span><span>−{euro(discountCents)}</span></div>
              </>
            )}
            <div className="grand"><span>Totale</span><span>{euro(total)}</span></div>
          </div>
          <div className="cart-actions">
            <button onClick={() => { if (cart.length === 0 || confirm('Svuotare l’ordine?')) reset(); }} disabled={cart.length === 0}>Svuota</button>
            <button onClick={() => setModal({ t: 'discount' })} disabled={cart.length === 0}>Sconto</button>
            <button className="primary big" disabled={cart.length === 0 || needsTable} onClick={() => setModal({ t: 'pay' })} title={needsTable ? 'Indica tavolo o nome' : ''}>
              Incassa
            </button>
          </div>
          <div className="till-name muted">
            Postazione: {till.name} · <button className="link" onClick={() => setTillId(null)}>cambia</button>
          </div>
        </div>
      </aside>

      {modal?.t === 'price' && (
        <PriceModal
          product={modal.product}
          onClose={() => setModal(null)}
          onOk={(c) => { addProduct(modal.product, c); setModal(null); }}
        />
      )}
      {modal?.t === 'menu' && (
        <MenuModal
          menu={modal.menu}
          catalog={catalog}
          used={used}
          onClose={() => setModal(null)}
          onOk={(components) => {
            setLast(null);
            setCart((c) => [...c, { key: nextKey++, kind: 'menu', menuId: modal.menu.id, qty: 1, gift: false, note: '', components }]);
            setModal(null);
          }}
        />
      )}
      {modal?.t === 'line' && (() => {
        const line = cart.find((l) => l.key === modal.key);
        if (!line) return null;
        return (
          <LineModal
            name={lineName(line)}
            line={line}
            onClose={() => setModal(null)}
            onSave={(patch) => { updateLine(line.key, patch); setModal(null); }}
          />
        );
      })()}
      {modal?.t === 'discount' && (
        <DiscountModal
          current={discount}
          subtotal={subtotal}
          onClose={() => setModal(null)}
          onOk={(d) => { setDiscount(d); setModal(null); }}
        />
      )}
      {modal?.t === 'pay' && <PayModal total={total} onClose={() => setModal(null)} onPay={submit} />}
    </div>
  );
}

function PriceModal(props: { product: Product; onClose: () => void; onOk: (cents: number) => void }) {
  const [v, setV] = useState('');
  const cents = parseEuro(v);
  return (
    <Modal title={`Prezzo: ${props.product.name}`} onClose={props.onClose}>
      <div className="display">{v ? `€ ${v}` : <span className="muted">€ 0,00</span>}</div>
      <Keypad value={v} onChange={setV} decimal />
      <button className="primary big" disabled={cents === null} onClick={() => props.onOk(cents!)}>Aggiungi</button>
    </Modal>
  );
}

function MenuModal(props: {
  menu: Menu;
  catalog: Catalog;
  used: Map<string, number>;
  onClose: () => void;
  onOk: (c: { componentId: number; productIds: number[] }[]) => void;
}) {
  const products = new Map(props.catalog.products.map((p) => [p.id, p]));
  const [picks, setPicks] = useState<Record<number, number[]>>(() => {
    // componenti con una sola possibilità: già scelti
    const init: Record<number, number[]> = {};
    for (const c of props.menu.components) {
      if (c.productIds.length === 1) init[c.id] = Array(c.choices).fill(c.productIds[0]);
    }
    return init;
  });

  // disponibilità tenendo conto anche delle scelte in corso
  const usedWithPicks = new Map(props.used);
  for (const pids of Object.values(picks)) {
    for (const pid of pids) {
      const p = products.get(pid);
      if (!p || p.stockMode === 'unlimited') continue;
      const key = p.stockMode === 'own' ? `p:${p.id}` : `s:${p.storageId}`;
      usedWithPicks.set(key, (usedWithPicks.get(key) ?? 0) + p.stockUnits);
    }
  }

  const complete = props.menu.components.every((c) => (picks[c.id]?.length ?? 0) === c.choices);
  return (
    <Modal title={`${props.menu.name} — ${euro(props.menu.priceCents)}`} onClose={props.onClose} wide>
      {props.menu.components.map((c) => {
        const chosen = picks[c.id] ?? [];
        return (
          <div key={c.id} className="menu-comp">
            <h3>
              {c.name} <span className="muted">({chosen.length}/{c.choices})</span>
              {chosen.length > 0 && (
                <button className="link" onClick={() => setPicks({ ...picks, [c.id]: [] })}>azzera</button>
              )}
            </h3>
            <div className="product-grid small">
              {c.productIds.map((pid) => {
                const p = products.get(pid);
                if (!p) return null;
                const left = remaining(p, props.catalog, usedWithPicks);
                const count = chosen.filter((x) => x === pid).length;
                return (
                  <button
                    key={pid}
                    className={`product ${count ? 'selected' : ''}`}
                    disabled={left === 0 || chosen.length >= c.choices}
                    onClick={() => setPicks({ ...picks, [c.id]: [...chosen, pid] })}
                  >
                    <span className="name">{p.name}</span>
                    {count > 0 && <span className="count">×{count}</span>}
                    {left !== null && <span className={`stock ${left === 0 ? 'out' : ''}`}>{left === 0 ? 'Esaurito' : `${left}`}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      <button
        className="primary big"
        disabled={!complete}
        onClick={() => props.onOk(props.menu.components.map((c) => ({ componentId: c.id, productIds: picks[c.id] ?? [] })))}
      >
        Aggiungi menù
      </button>
    </Modal>
  );
}

function LineModal(props: { name: string; line: CartLine; onClose: () => void; onSave: (p: Partial<CartLine> | null) => void }) {
  const [qty, setQty] = useState(String(props.line.qty));
  const [gift, setGift] = useState(props.line.gift);
  const [note, setNote] = useState(props.line.note);
  const n = Number(qty);
  return (
    <Modal title={props.name} onClose={props.onClose}>
      <div className="display">{qty || <span className="muted">0</span>} pz</div>
      <Keypad value={qty} onChange={(v) => setQty(v.slice(0, 3))} />
      <Field label="Nota per la cucina">
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="es. senza cipolla" />
      </Field>
      <label className="check">
        <input type="checkbox" checked={gift} onChange={(e) => setGift(e.target.checked)} /> Omaggio (non pagato)
      </label>
      <div className="row-actions">
        <button className="danger" onClick={() => props.onSave(null)}>Rimuovi</button>
        <button className="primary" disabled={!(n >= 1)} onClick={() => props.onSave({ qty: n, gift, note: note.trim() })}>Salva</button>
      </div>
    </Modal>
  );
}

function DiscountModal(props: {
  current: NewOrder['discount'];
  subtotal: number;
  onClose: () => void;
  onOk: (d: NewOrder['discount']) => void;
}) {
  const [type, setType] = useState<'percent' | 'amount'>(props.current?.type ?? 'percent');
  const [v, setV] = useState(
    props.current ? (props.current.type === 'percent' ? String(props.current.value) : (props.current.value / 100).toFixed(2).replace('.', ',')) : '',
  );
  const value = type === 'percent' ? Number(v.replace(',', '.')) : parseEuro(v);
  const valid = value !== null && Number.isFinite(value) && value >= 0 && (type === 'amount' || value <= 100);
  return (
    <Modal title="Sconto" onClose={props.onClose}>
      <div className="segmented">
        <button className={type === 'percent' ? 'active' : ''} onClick={() => { setType('percent'); setV(''); }}>%</button>
        <button className={type === 'amount' ? 'active' : ''} onClick={() => { setType('amount'); setV(''); }}>€</button>
      </div>
      <div className="display">{v || '0'} {type === 'percent' ? '%' : '€'}</div>
      <Keypad value={v} onChange={setV} decimal />
      <div className="row-actions">
        <button onClick={() => props.onOk(undefined)}>Nessuno sconto</button>
        <button className="primary" disabled={!valid} onClick={() => props.onOk({ type, value: value! })}>Applica</button>
      </div>
    </Modal>
  );
}

function PayModal(props: { total: number; onClose: () => void; onPay: (m: PaymentMethod, paid: number) => Promise<void> }) {
  const [method, setMethod] = useState<PaymentMethod>('contanti');
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  const given = v ? parseEuro(v) ?? 0 : props.total;
  const change = given - props.total;
  const ok = method !== 'contanti' || given >= props.total;

  const pay = async () => {
    if (!ok || busy) return;
    setBusy(true);
    await props.onPay(method, method === 'contanti' ? given : 0);
    setBusy(false);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Enter' && void pay();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const quick = [500, 1000, 2000, 5000].filter((c) => c >= props.total);
  return (
    <Modal title={`Totale ${euro(props.total)}`} onClose={props.onClose}>
      <div className="segmented">
        {(['contanti', 'carta', 'altro'] as const).map((m) => (
          <button key={m} className={method === m ? 'active' : ''} onClick={() => setMethod(m)}>{m}</button>
        ))}
      </div>
      {method === 'contanti' && (
        <>
          <div className="display">
            <small className="muted">Ricevuto</small> {v ? `€ ${v}` : euro(props.total)}
          </div>
          <div className="quick-cash">
            <button onClick={() => setV('')}>Esatto</button>
            {quick.map((c) => (
              <button key={c} onClick={() => setV(String(c / 100))}>{euro(c)}</button>
            ))}
          </div>
          <Keypad value={v} onChange={setV} decimal />
          <div className={`change ${change < 0 ? 'neg' : ''}`}>
            {change >= 0 ? `Resto ${euro(change)}` : `Mancano ${euro(-change)}`}
          </div>
        </>
      )}
      <button className="primary big" disabled={!ok || busy} onClick={pay}>
        {busy ? 'Registrazione…' : 'Conferma e stampa'}
      </button>
    </Modal>
  );
}
