import type { DB } from './db.js';
import type {
  Catalog, Family, Menu, Order, OrderLine, Printer, Product, Settings, Station, Storage, Till,
} from '../shared/types.js';

export const DEFAULT_SETTINGS: Settings = {
  eventName: 'Sagra',
  receiptHeader: '',
  receiptFooter: 'Grazie e buon appetito!',
  printReceipt: true,
  printPickupTicket: true,
  pricesOnComande: false,
  requireTable: false,
};

export function getSettings(db: DB): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  return { ...DEFAULT_SETTINGS, ...stored };
}

export function saveSettings(db: DB, patch: Partial<Settings>) {
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  db.transaction(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (k in DEFAULT_SETTINGS) stmt.run(k, JSON.stringify(v));
    }
  })();
}

// ---- Mappatura righe SQL -> oggetti ----

type Row = Record<string, any>;

export const mapPrinter = (r: Row): Printer => ({
  id: r.id, name: r.name, kind: r.kind, address: r.address, widthChars: r.width_chars,
});
export const mapTill = (r: Row): Till => ({
  id: r.id, name: r.name, receiptPrinterId: r.receipt_printer_id,
});
export const mapStation = (r: Row): Station => ({
  id: r.id, name: r.name, printerId: r.printer_id, enabled: !!r.enabled, sort: r.sort,
});
export const mapFamily = (r: Row): Family => ({
  id: r.id, name: r.name, color: r.color, visible: !!r.visible, sort: r.sort,
});
export const mapStorage = (r: Row): Storage => ({ id: r.id, name: r.name, quantity: r.quantity });

/** Pezzi vendibili dato lo stato di magazzino; null = illimitato. */
export function availableUnits(p: { stockMode: string; stockQty: number; stockUnits: number }, storageQty: number | undefined): number | null {
  if (p.stockMode === 'unlimited') return null;
  const qty = p.stockMode === 'own' ? p.stockQty : storageQty ?? 0;
  return Math.max(0, Math.floor(qty / p.stockUnits + 1e-9));
}

export function listProducts(db: DB): Product[] {
  const storages = new Map(
    (db.prepare('SELECT id, quantity FROM storages').all() as Row[]).map((s) => [s.id, s.quantity as number]),
  );
  return (db.prepare('SELECT * FROM products ORDER BY family_id, sort, name').all() as Row[]).map((r) => {
    const p = {
      id: r.id,
      familyId: r.family_id,
      stationId: r.station_id,
      name: r.name,
      priceCents: r.price_cents,
      stockMode: r.stock_mode,
      stockQty: r.stock_qty,
      storageId: r.storage_id,
      stockUnits: r.stock_units,
      lowStock: r.low_stock,
      printMode: r.print_mode,
      visible: !!r.visible,
      menuOnly: !!r.menu_only,
      sort: r.sort,
      available: null as number | null,
    };
    p.available = availableUnits(p, r.storage_id ? storages.get(r.storage_id) : undefined);
    return p;
  });
}

export function listMenus(db: DB): Menu[] {
  const menus = db.prepare('SELECT * FROM menus ORDER BY sort, name').all() as Row[];
  const comps = db.prepare('SELECT * FROM menu_components ORDER BY sort, id').all() as Row[];
  const links = db.prepare('SELECT * FROM menu_component_products ORDER BY sort, product_id').all() as Row[];
  return menus.map((m) => ({
    id: m.id,
    name: m.name,
    priceCents: m.price_cents,
    color: m.color,
    visible: !!m.visible,
    sort: m.sort,
    components: comps
      .filter((c) => c.menu_id === m.id)
      .map((c) => ({
        id: c.id,
        name: c.name,
        choices: c.choices,
        sort: c.sort,
        productIds: links.filter((l) => l.component_id === c.id).map((l) => l.product_id),
      })),
  }));
}

export function getCatalog(db: DB): Catalog {
  return {
    families: (db.prepare('SELECT * FROM families ORDER BY sort, name').all() as Row[]).map(mapFamily),
    products: listProducts(db),
    menus: listMenus(db),
    stations: (db.prepare('SELECT * FROM stations ORDER BY sort, name').all() as Row[]).map(mapStation),
    storages: (db.prepare('SELECT * FROM storages ORDER BY name').all() as Row[]).map(mapStorage),
  };
}

// ---- Ordini ----

const mapLine = (r: Row): OrderLine => ({
  id: r.id,
  parentLineId: r.parent_line_id,
  productId: r.product_id,
  menuId: r.menu_id,
  name: r.name,
  familyName: r.family_name,
  qty: r.qty,
  unitPriceCents: r.unit_price_cents,
  gift: !!r.gift,
  note: r.note,
  stationId: r.station_id,
  kitchenStatus: r.kitchen_status,
  readyAt: r.ready_at,
});

const mapOrder = (r: Row, lines: OrderLine[]): Order => ({
  id: r.id,
  number: r.number,
  createdAt: r.created_at,
  operatorId: r.operator_id,
  operatorName: r.operator_name ?? null,
  tillId: r.till_id,
  tableLabel: r.table_label,
  takeaway: !!r.takeaway,
  note: r.note,
  subtotalCents: r.subtotal_cents,
  discountCents: r.discount_cents,
  totalCents: r.total_cents,
  paidCents: r.paid_cents,
  paymentMethod: r.payment_method,
  status: r.status,
  voidedAt: r.voided_at,
  voidReason: r.void_reason,
  closureId: r.closure_id,
  lines,
});

const ORDER_SELECT = `
  SELECT o.*, op.name AS operator_name
  FROM orders o LEFT JOIN operators op ON op.id = o.operator_id`;

export function getOrder(db: DB, id: number): Order | undefined {
  const r = db.prepare(`${ORDER_SELECT} WHERE o.id = ?`).get(id) as Row | undefined;
  if (!r) return undefined;
  const lines = (db.prepare('SELECT * FROM order_lines WHERE order_id = ? ORDER BY id').all(id) as Row[]).map(mapLine);
  return mapOrder(r, lines);
}

export function listOrders(db: DB, opts: { closureId?: number | null; limit?: number; ids?: number[] }): Order[] {
  let where = '1 = 1';
  const params: unknown[] = [];
  if (opts.ids) {
    if (opts.ids.length === 0) return [];
    where = `o.id IN (${opts.ids.map(() => '?').join(',')})`;
    params.push(...opts.ids);
  } else if (opts.closureId === null) {
    where = 'o.closure_id IS NULL';
  } else if (opts.closureId !== undefined) {
    where = 'o.closure_id = ?';
    params.push(opts.closureId);
  }
  const rows = db
    .prepare(`${ORDER_SELECT} WHERE ${where} ORDER BY o.id DESC LIMIT ?`)
    .all(...params, opts.limit ?? 500) as Row[];
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const lines = db
    .prepare(`SELECT * FROM order_lines WHERE order_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`)
    .all(...ids) as Row[];
  const byOrder = new Map<number, OrderLine[]>();
  for (const l of lines) {
    const arr = byOrder.get(l.order_id) ?? [];
    arr.push(mapLine(l));
    byOrder.set(l.order_id, arr);
  }
  return rows.map((r) => mapOrder(r, byOrder.get(r.id) ?? []));
}
