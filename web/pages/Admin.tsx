import { useEffect, useState, type ReactNode } from 'react';
import type { Catalog, Menu, Printer, Settings } from '../../shared/types';
import { del, euro, get, parseEuro, post, put, useLoad } from '../api';
import { Field, Modal, useToast } from '../components/ui';

type Option = { value: string | number | null; label: string };
type FieldDef = {
  key: string;
  label: string;
  type: 'text' | 'money' | 'moneyOrNull' | 'number' | 'bool' | 'color' | 'select' | 'password';
  options?: Option[];
  hint?: string;
  showIf?: (v: Record<string, any>) => boolean;
};

/** Converte i valori del form (stringhe) nel corpo JSON per l'API. */
function toBody(fields: FieldDef[], form: Record<string, any>) {
  const body: Record<string, any> = {};
  for (const f of fields) {
    const v = form[f.key];
    switch (f.type) {
      case 'money': body[f.key] = parseEuro(String(v ?? '')) ?? 0; break;
      case 'moneyOrNull': body[f.key] = String(v ?? '').trim() === '' ? null : parseEuro(String(v)); break;
      case 'number': body[f.key] = Number(String(v ?? '0').replace(',', '.')) || 0; break;
      case 'password': if (v) body[f.key] = v; break;
      default: body[f.key] = v;
    }
  }
  return body;
}

function toForm(fields: FieldDef[], row: Record<string, any>) {
  const form: Record<string, any> = { ...row };
  for (const f of fields) {
    if (f.type === 'money') form[f.key] = (row[f.key] / 100).toFixed(2).replace('.', ',');
    if (f.type === 'moneyOrNull') form[f.key] = row[f.key] === null ? '' : (row[f.key] / 100).toFixed(2).replace('.', ',');
    if (f.type === 'number') form[f.key] = String(row[f.key]).replace('.', ',');
    if (f.type === 'password') form[f.key] = '';
  }
  return form;
}

function FormFields({ fields, form, setForm }: { fields: FieldDef[]; form: Record<string, any>; setForm: (f: Record<string, any>) => void }) {
  return (
    <div className="form-grid">
      {fields.filter((f) => !f.showIf || f.showIf(form)).map((f) => {
        const set = (v: unknown) => setForm({ ...form, [f.key]: v });
        if (f.type === 'bool') {
          return (
            <label key={f.key} className="check">
              <input type="checkbox" checked={!!form[f.key]} onChange={(e) => set(e.target.checked)} /> {f.label}
            </label>
          );
        }
        let input: ReactNode;
        if (f.type === 'select') {
          input = (
            <select value={form[f.key] ?? ''} onChange={(e) => {
              const opt = f.options!.find((o) => String(o.value ?? '') === e.target.value);
              set(opt ? opt.value : null);
            }}>
              {f.options!.map((o) => <option key={String(o.value)} value={o.value ?? ''}>{o.label}</option>)}
            </select>
          );
        } else if (f.type === 'color') {
          input = <input type="color" value={form[f.key] ?? '#888888'} onChange={(e) => set(e.target.value)} />;
        } else {
          input = (
            <input
              value={form[f.key] ?? ''}
              onChange={(e) => set(e.target.value)}
              type={f.type === 'password' ? 'password' : 'text'}
              inputMode={f.type === 'text' ? 'text' : f.type === 'password' ? 'numeric' : 'decimal'}
            />
          );
        }
        return <Field key={f.key} label={f.label} hint={f.hint}>{input}</Field>;
      })}
    </div>
  );
}

function EntityEditor(props: {
  title: string;
  endpoint: string;
  fields: FieldDef[];
  defaults: Record<string, any>;
  columns: { label: string; render: (r: any) => ReactNode; num?: boolean }[];
  rows: any[] | null;
  reload: () => void;
  extraActions?: (row: any) => ReactNode;
  canDelete?: boolean;
  intro?: ReactNode;
}) {
  const [editing, setEditing] = useState<Record<string, any> | null>(null);
  const toast = useToast();

  const save = async () => {
    if (!editing) return;
    try {
      const body = toBody(props.fields, editing);
      if (editing.id) await put(`${props.endpoint}/${editing.id}`, body);
      else await post(props.endpoint, body);
      setEditing(null);
      props.reload();
      toast('Salvato');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const remove = async () => {
    if (!editing?.id || !confirm('Eliminare definitivamente?')) return;
    try {
      await del(`${props.endpoint}/${editing.id}`);
      setEditing(null);
      props.reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <section>
      <div className="page-head">
        <h2>{props.title}</h2>
        <button className="primary" onClick={() => setEditing({ ...props.defaults })}>+ Nuovo</button>
      </div>
      {props.intro}
      <table className="table">
        <thead>
          <tr>{props.columns.map((c) => <th key={c.label} className={c.num ? 'num' : ''}>{c.label}</th>)}<th /></tr>
        </thead>
        <tbody>
          {props.rows?.map((r) => (
            <tr key={r.id} onClick={() => setEditing(toForm(props.fields, r))}>
              {props.columns.map((c) => <td key={c.label} className={c.num ? 'num' : ''}>{c.render(r)}</td>)}
              <td onClick={(e) => e.stopPropagation()}>{props.extraActions?.(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {props.rows?.length === 0 && <p className="muted">Nessun elemento.</p>}
      {editing && (
        <Modal title={editing.id ? 'Modifica' : 'Nuovo'} onClose={() => setEditing(null)} wide>
          <FormFields fields={props.fields} form={editing} setForm={setEditing} />
          <div className="row-actions">
            {editing.id && props.canDelete !== false && <button className="danger" onClick={remove}>Elimina</button>}
            <button className="primary" onClick={save}>Salva</button>
          </div>
        </Modal>
      )}
    </section>
  );
}

const SECTIONS = ['Prodotti', 'Famiglie', 'Menù', 'Magazzini', 'Reparti', 'Stampanti', 'Casse', 'Operatori', 'Impostazioni', 'Dati'] as const;

export function Admin() {
  const [section, setSection] = useState<(typeof SECTIONS)[number]>('Prodotti');
  const { data: catalog, reload: reloadCatalog } = useLoad<Catalog>('/catalog', ['catalog', 'stock']);
  const { data: printers, reload: reloadPrinters } = useLoad<Printer[]>('/admin/printers');
  const { data: tills, reload: reloadTills } = useLoad<any[]>('/admin/tills');
  const { data: operators, reload: reloadOperators } = useLoad<any[]>('/admin/operators');
  const toast = useToast();

  if (!catalog || !printers) return <div className="center-screen">Caricamento…</div>;

  const printerOpts: Option[] = [{ value: null, label: '— nessuna —' }, ...printers.map((p) => ({ value: p.id, label: p.name }))];
  const familyName = (id: number) => catalog.families.find((f) => f.id === id)?.name ?? '?';
  const stationName = (id: number | null) => catalog.stations.find((s) => s.id === id)?.name ?? '—';

  return (
    <div className="admin">
      <nav className="admin-nav">
        {SECTIONS.map((s) => (
          <button key={s} className={s === section ? 'active' : ''} onClick={() => setSection(s)}>{s}</button>
        ))}
      </nav>
      <div className="admin-body">
        {section === 'Prodotti' && (
          <EntityEditor
            title="Prodotti"
            endpoint="/admin/products"
            rows={catalog.products}
            reload={reloadCatalog}
            intro={catalog.families.length === 0 ? <p className="alert">Crea prima almeno una famiglia.</p> : undefined}
            defaults={{
              familyId: catalog.families[0]?.id, stationId: null, name: '', priceCents: '0,00', stockMode: 'unlimited',
              stockQty: '0', storageId: catalog.storages[0]?.id ?? null, stockUnits: '1', lowStock: '0',
              printMode: 'grouped', visible: true, menuOnly: false, sort: '0',
            }}
            fields={[
              { key: 'name', label: 'Nome', type: 'text' },
              { key: 'familyId', label: 'Famiglia', type: 'select', options: catalog.families.map((f) => ({ value: f.id, label: f.name })) },
              { key: 'priceCents', label: 'Prezzo €', type: 'moneyOrNull', hint: 'Vuoto = prezzo libero, chiesto alla vendita' },
              { key: 'stationId', label: 'Reparto (comanda)', type: 'select', options: [{ value: null, label: '— nessuno: solo scontrino —' }, ...catalog.stations.map((s) => ({ value: s.id, label: s.name }))] },
              { key: 'printMode', label: 'Stampa in comanda', type: 'select', options: [{ value: 'grouped', label: 'Insieme agli altri' }, { value: 'separate', label: 'Un foglietto per pezzo' }] },
              { key: 'stockMode', label: 'Magazzino', type: 'select', options: [{ value: 'unlimited', label: 'Illimitato' }, { value: 'own', label: 'Quantità propria' }, { value: 'shared', label: 'Magazzino condiviso' }] },
              { key: 'stockQty', label: 'Quantità disponibile', type: 'number', showIf: (f) => f.stockMode === 'own' },
              { key: 'storageId', label: 'Magazzino condiviso', type: 'select', showIf: (f) => f.stockMode === 'shared', options: catalog.storages.map((s) => ({ value: s.id, label: s.name })) },
              { key: 'stockUnits', label: 'Unità scaricate per pezzo', type: 'number', showIf: (f) => f.stockMode !== 'unlimited', hint: 'Es. 0,5 per mezza bottiglia' },
              { key: 'lowStock', label: 'Avviso sotto i', type: 'number', showIf: (f) => f.stockMode !== 'unlimited' },
              { key: 'sort', label: 'Ordine', type: 'number' },
              { key: 'visible', label: 'Visibile in cassa', type: 'bool' },
              { key: 'menuOnly', label: 'Solo dentro i menù', type: 'bool' },
            ]}
            columns={[
              { label: 'Famiglia', render: (r) => familyName(r.familyId) },
              { label: 'Nome', render: (r) => <>{r.name}{!r.visible && <span className="badge">nascosto</span>}</> },
              { label: 'Reparto', render: (r) => stationName(r.stationId) },
              { label: 'Disponibili', num: true, render: (r) => (r.available === null ? '∞' : r.available) },
              { label: 'Prezzo', num: true, render: (r) => (r.priceCents === null ? 'libero' : euro(r.priceCents)) },
            ]}
          />
        )}

        {section === 'Famiglie' && (
          <EntityEditor
            title="Famiglie"
            endpoint="/admin/families"
            rows={catalog.families}
            reload={reloadCatalog}
            defaults={{ name: '', color: '#4f7cff', visible: true, sort: String(catalog.families.length) }}
            fields={[
              { key: 'name', label: 'Nome', type: 'text' },
              { key: 'color', label: 'Colore', type: 'color' },
              { key: 'sort', label: 'Ordine', type: 'number' },
              { key: 'visible', label: 'Visibile in cassa', type: 'bool' },
            ]}
            columns={[
              { label: '', render: (r) => <span className="swatch" style={{ background: r.color }} /> },
              { label: 'Nome', render: (r) => r.name },
              { label: 'Prodotti', num: true, render: (r) => catalog.products.filter((p) => p.familyId === r.id).length },
            ]}
          />
        )}

        {section === 'Menù' && <MenuEditor catalog={catalog} reload={reloadCatalog} />}

        {section === 'Magazzini' && (
          <EntityEditor
            title="Magazzini condivisi"
            endpoint="/admin/storages"
            rows={catalog.storages}
            reload={reloadCatalog}
            intro={<p className="muted">Un magazzino condiviso è una scorta usata da più prodotti, ad esempio l'impasto per tutte le tigelle.</p>}
            defaults={{ name: '', quantity: '0' }}
            fields={[
              { key: 'name', label: 'Nome', type: 'text' },
              { key: 'quantity', label: 'Quantità attuale', type: 'number' },
            ]}
            columns={[
              { label: 'Nome', render: (r) => r.name },
              { label: 'Quantità', num: true, render: (r) => r.quantity },
              { label: 'Prodotti collegati', render: (r) => catalog.products.filter((p) => p.storageId === r.id && p.stockMode === 'shared').map((p) => p.name).join(', ') },
            ]}
            extraActions={(r) => (
              <button
                onClick={async () => {
                  const v = prompt(`Nuova quantità per "${r.name}"`, String(r.quantity));
                  if (v === null) return;
                  try {
                    await post('/admin/stock', { storageId: r.id, setTo: Number(v.replace(',', '.')) });
                  } catch (e) {
                    toast((e as Error).message, 'error');
                  }
                }}
              >
                Rettifica
              </button>
            )}
          />
        )}

        {section === 'Reparti' && (
          <EntityEditor
            title="Reparti (comande)"
            endpoint="/admin/stations"
            rows={catalog.stations}
            reload={reloadCatalog}
            intro={<p className="muted">Ogni reparto riceve la sua comanda stampata e ha il suo monitor in Cucina.</p>}
            defaults={{ name: '', printerId: null, enabled: true, sort: String(catalog.stations.length) }}
            fields={[
              { key: 'name', label: 'Nome', type: 'text' },
              { key: 'printerId', label: 'Stampante comande', type: 'select', options: printerOpts },
              { key: 'sort', label: 'Ordine', type: 'number' },
              { key: 'enabled', label: 'Attivo', type: 'bool' },
            ]}
            columns={[
              { label: 'Nome', render: (r) => r.name },
              { label: 'Stampante', render: (r) => printers.find((p) => p.id === r.printerId)?.name ?? '—' },
              { label: 'Stato', render: (r) => (r.enabled ? 'attivo' : 'disattivato') },
            ]}
          />
        )}

        {section === 'Stampanti' && (
          <EntityEditor
            title="Stampanti"
            endpoint="/admin/printers"
            rows={printers}
            reload={reloadPrinters}
            intro={
              <p className="muted">
                Stampanti termiche ESC/POS. <b>Rete</b>: indirizzo IP (porta 9100 se omessa). <b>USB su questo Mac</b>: nome della coda CUPS
                (Impostazioni di Sistema → Stampanti; con <code>lpstat -p</code> nel Terminale). <b>Anteprima</b>: salva un file di testo in
                data/anteprime-stampa, utile per le prove.
              </p>
            }
            defaults={{ name: '', kind: 'network', address: '', widthChars: 42 }}
            fields={[
              { key: 'name', label: 'Nome', type: 'text' },
              { key: 'kind', label: 'Collegamento', type: 'select', options: [{ value: 'network', label: 'Rete (IP)' }, { value: 'cups', label: 'USB su questo Mac (CUPS)' }, { value: 'file', label: 'Anteprima su file' }] },
              { key: 'address', label: 'Indirizzo IP o coda CUPS', type: 'text', showIf: (f) => f.kind !== 'file', hint: 'es. 192.168.1.50 oppure POS_80' },
              { key: 'widthChars', label: 'Caratteri per riga', type: 'select', options: [{ value: 42, label: '42 (carta 80 mm)' }, { value: 48, label: '48 (80 mm, font piccolo)' }, { value: 32, label: '32 (carta 58 mm)' }] },
            ]}
            columns={[
              { label: 'Nome', render: (r) => r.name },
              { label: 'Tipo', render: (r) => ({ network: 'Rete', cups: 'USB', file: 'Anteprima' })[r.kind as string] },
              { label: 'Indirizzo', render: (r) => r.address },
            ]}
            extraActions={(r) => (
              <button
                onClick={async () => {
                  try {
                    await post(`/admin/printers/${r.id}/test`);
                    toast('Prova di stampa inviata');
                  } catch (e) {
                    toast((e as Error).message, 'error');
                  }
                }}
              >
                Prova
              </button>
            )}
          />
        )}

        {section === 'Casse' && (
          <EntityEditor
            title="Postazioni cassa"
            endpoint="/admin/tills"
            rows={tills}
            reload={reloadTills}
            intro={<p className="muted">Ogni computer o tablet che vende sceglie la sua postazione; scontrino e ticket ritiro escono sulla sua stampante.</p>}
            defaults={{ name: '', receiptPrinterId: null }}
            fields={[
              { key: 'name', label: 'Nome', type: 'text' },
              { key: 'receiptPrinterId', label: 'Stampante scontrini', type: 'select', options: printerOpts },
            ]}
            columns={[
              { label: 'Nome', render: (r) => r.name },
              { label: 'Stampante', render: (r) => printers.find((p) => p.id === r.receiptPrinterId)?.name ?? '—' },
            ]}
          />
        )}

        {section === 'Operatori' && (
          <EntityEditor
            title="Operatori"
            endpoint="/admin/operators"
            rows={operators}
            reload={reloadOperators}
            canDelete={false}
            intro={<p className="muted"><b>Cassa</b>: vende, vede ordini e statistiche. <b>Cucina</b>: solo monitor dei reparti. <b>Admin</b>: tutto. Per togliere l'accesso, disattiva l'operatore.</p>}
            defaults={{ name: '', role: 'cassa', active: true, pin: '' }}
            fields={[
              { key: 'name', label: 'Nome', type: 'text' },
              { key: 'role', label: 'Ruolo', type: 'select', options: [{ value: 'cassa', label: 'Cassa' }, { value: 'cucina', label: 'Cucina' }, { value: 'admin', label: 'Amministratore' }] },
              { key: 'pin', label: 'PIN', type: 'password', hint: 'Da 4 a 8 cifre. Lascia vuoto per non cambiarlo.' },
              { key: 'active', label: 'Attivo', type: 'bool' },
            ]}
            columns={[
              { label: 'Nome', render: (r) => r.name },
              { label: 'Ruolo', render: (r) => r.role },
              { label: 'Stato', render: (r) => (r.active ? 'attivo' : 'disattivato') },
            ]}
          />
        )}

        {section === 'Impostazioni' && <SettingsEditor />}
        {section === 'Dati' && <DataTools onImported={reloadCatalog} />}
      </div>
    </div>
  );
}

function MenuEditor({ catalog, reload }: { catalog: Catalog; reload: () => void }) {
  const [editing, setEditing] = useState<(Omit<Menu, 'id' | 'priceCents'> & { id?: number; price: string }) | null>(null);
  const toast = useToast();
  const productName = (id: number) => catalog.products.find((p) => p.id === id)?.name ?? '?';

  const save = async () => {
    if (!editing) return;
    const priceCents = parseEuro(editing.price);
    if (priceCents === null) return toast('Prezzo non valido', 'error');
    const body = {
      name: editing.name, priceCents, color: editing.color, visible: editing.visible, sort: editing.sort,
      components: editing.components.map((c) => ({ name: c.name, choices: c.choices, productIds: c.productIds })),
    };
    try {
      if (editing.id) await put(`/admin/menus/${editing.id}`, body);
      else await post('/admin/menus', body);
      setEditing(null);
      reload();
      toast('Menù salvato');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const setComp = (i: number, patch: Partial<Menu['components'][number]>) =>
    setEditing((m) => m && { ...m, components: m.components.map((c, j) => (j === i ? { ...c, ...patch } : c)) });

  return (
    <section>
      <div className="page-head">
        <h2>Menù</h2>
        <button className="primary" onClick={() => setEditing({ name: '', price: '0,00', color: '#7c5cff', visible: true, sort: 0, components: [] })}>+ Nuovo</button>
      </div>
      <p className="muted">Un menù ha un prezzo fisso e uno o più componenti; per ogni componente il cliente sceglie tra i prodotti indicati. Il magazzino scala i prodotti scelti.</p>
      <table className="table">
        <thead><tr><th>Nome</th><th>Componenti</th><th className="num">Prezzo</th></tr></thead>
        <tbody>
          {catalog.menus.map((m) => (
            <tr key={m.id} onClick={() => setEditing({ ...m, price: (m.priceCents / 100).toFixed(2).replace('.', ',') })}>
              <td>{m.name}{!m.visible && <span className="badge">nascosto</span>}</td>
              <td className="muted">{m.components.map((c) => `${c.name} (${c.choices})`).join(' · ')}</td>
              <td className="num">{euro(m.priceCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && (
        <Modal title={editing.id ? 'Modifica menù' : 'Nuovo menù'} onClose={() => setEditing(null)} wide>
          <div className="form-grid">
            <Field label="Nome"><input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
            <Field label="Prezzo €"><input value={editing.price} inputMode="decimal" onChange={(e) => setEditing({ ...editing, price: e.target.value })} /></Field>
            <Field label="Colore"><input type="color" value={editing.color} onChange={(e) => setEditing({ ...editing, color: e.target.value })} /></Field>
            <label className="check"><input type="checkbox" checked={editing.visible} onChange={(e) => setEditing({ ...editing, visible: e.target.checked })} /> Visibile in cassa</label>
          </div>
          {editing.components.map((c, i) => (
            <fieldset key={i} className="component-edit">
              <legend>Componente {i + 1}</legend>
              <div className="form-grid">
                <Field label="Nome"><input value={c.name} onChange={(e) => setComp(i, { name: e.target.value })} placeholder="es. Primo" /></Field>
                <Field label="Quante scelte"><input value={c.choices} inputMode="numeric" onChange={(e) => setComp(i, { choices: Math.max(1, Number(e.target.value) || 1) })} /></Field>
              </div>
              <div className="chips">
                {catalog.products.map((p) => {
                  const on = c.productIds.includes(p.id);
                  return (
                    <button key={p.id} type="button" className={`chip ${on ? 'on' : ''}`}
                      onClick={() => setComp(i, { productIds: on ? c.productIds.filter((x) => x !== p.id) : [...c.productIds, p.id] })}>
                      {p.name}
                    </button>
                  );
                })}
              </div>
              <small className="muted">Scelti: {c.productIds.map(productName).join(', ') || 'nessuno'}</small>
              <div><button className="link danger" onClick={() => setEditing({ ...editing, components: editing.components.filter((_, j) => j !== i) })}>Rimuovi componente</button></div>
            </fieldset>
          ))}
          <button onClick={() => setEditing({ ...editing, components: [...editing.components, { id: 0, name: '', choices: 1, sort: 0, productIds: [] }] })}>+ Componente</button>
          <div className="row-actions">
            {editing.id && (
              <button className="danger" onClick={async () => {
                if (!confirm('Eliminare il menù?')) return;
                await del(`/admin/menus/${editing.id}`);
                setEditing(null);
                reload();
              }}>Elimina</button>
            )}
            <button className="primary" onClick={save}>Salva</button>
          </div>
        </Modal>
      )}
    </section>
  );
}

function SettingsEditor() {
  const [s, setS] = useState<Settings | null>(null);
  const toast = useToast();
  useEffect(() => {
    get<Settings>('/admin/settings').then(setS);
  }, []);
  if (!s) return null;
  const save = async () => {
    try {
      setS(await put<Settings>('/admin/settings', s));
      toast('Impostazioni salvate');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const bool = (key: keyof Settings, label: string) => (
    <label className="check"><input type="checkbox" checked={!!s[key]} onChange={(e) => setS({ ...s, [key]: e.target.checked })} /> {label}</label>
  );
  return (
    <section>
      <h2>Impostazioni</h2>
      <div className="form-grid">
        <Field label="Nome evento"><input value={s.eventName} onChange={(e) => setS({ ...s, eventName: e.target.value })} /></Field>
        <Field label="Intestazione scontrino"><input value={s.receiptHeader} onChange={(e) => setS({ ...s, receiptHeader: e.target.value })} placeholder="es. Pro Loco di …" /></Field>
        <Field label="Piè di pagina scontrino"><input value={s.receiptFooter} onChange={(e) => setS({ ...s, receiptFooter: e.target.value })} /></Field>
      </div>
      <div className="stack">
        {bool('printReceipt', 'Stampa lo scontrino riepilogativo')}
        {bool('printPickupTicket', 'Stampa il ticket di ritiro con il numero')}
        {bool('pricesOnComande', 'Mostra i prezzi sulle comande')}
        {bool('requireTable', 'Obbliga a indicare tavolo o nome')}
      </div>
      <button className="primary" onClick={save}>Salva</button>
    </section>
  );
}

function DataTools({ onImported }: { onImported: () => void }) {
  const [replace, setReplace] = useState(true);
  const [result, setResult] = useState<string | null>(null);
  const toast = useToast();

  const onFile = async (file: File) => {
    const buf = new Uint8Array(await file.arrayBuffer());
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      text = new TextDecoder('windows-1252').decode(buf);
    }
    if (replace && !confirm('Sostituire tutto il catalogo attuale (prodotti, famiglie, menù, magazzini, reparti)? Gli ordini restano.')) return;
    try {
      const r = await post('/admin/import-legacy', { text, replace });
      setResult(`Importati: ${r.families} famiglie, ${r.products} prodotti, ${r.storages} magazzini, ${r.stations} reparti, ${r.menus} menù.` +
        (r.skipped.length ? ` Saltati: ${r.skipped.join('; ')}` : ''));
      onImported();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <section>
      <h2>Backup</h2>
      <p className="muted">Viene salvato un backup automatico a ogni avvio, prima di ogni chiusura di cassa e prima di ogni importazione (cartella data/backup).</p>
      <a className="button" href="/api/admin/backup">Scarica backup adesso</a>

      <h2>Importa dal vecchio programma Cassa</h2>
      <p className="muted">
        Nel vecchio programma usa <b>Esporta</b>: crea un file di testo nella cartella <code>Save</code> (es. Save-20190819….txt).
        Importa famiglie, prodotti, prezzi, magazzini, reparti e menù. Dopo l'importazione collega le stampanti ai reparti.
      </p>
      <label className="check"><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Sostituisci il catalogo attuale</label>
      <input type="file" accept=".txt" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
      {result && <p className="alert ok">{result}</p>}
    </section>
  );
}
