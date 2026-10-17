import type { DB } from '../db.js';
import type { NewOrder, NewOrderMenuLine, NewOrderProductLine } from '../../shared/types.js';

/** Errore di regola di business: il messaggio è mostrato all'operatore. */
export class DomainError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

interface ProductRow {
  id: number;
  name: string;
  price_cents: number | null;
  station_id: number | null;
  station_enabled: number | null;
  stock_mode: 'unlimited' | 'own' | 'shared';
  stock_qty: number;
  storage_id: number | null;
  stock_units: number;
  family_name: string;
}

interface PlannedLine {
  parentIndex: number | null;
  productId: number | null;
  menuId: number | null;
  name: string;
  familyName: string;
  qty: number;
  unitPriceCents: number;
  gift: boolean;
  note: string;
  stationId: number | null;
}

const isMenuLine = (l: NewOrderProductLine | NewOrderMenuLine): l is NewOrderMenuLine => 'menuId' in l;

export function computeDiscount(subtotal: number, discount: NewOrder['discount']): number {
  if (!discount || discount.value <= 0) return 0;
  if (discount.type === 'percent') {
    if (discount.value > 100) throw new DomainError(400, 'Lo sconto non può superare il 100%');
    return Math.round((subtotal * discount.value) / 100);
  }
  return Math.min(Math.round(discount.value), subtotal);
}

/**
 * Crea un ordine in un'unica transazione: verifica disponibilità,
 * scala il magazzino, salva testata e righe. Restituisce l'id dell'ordine.
 */
export function createOrder(db: DB, input: NewOrder, operatorId: number): number {
  if (input.lines.length === 0) throw new DomainError(400, "L'ordine è vuoto");

  const productStmt = db.prepare(`
    SELECT p.*, s.enabled AS station_enabled, f.name AS family_name
    FROM products p
    JOIN families f ON f.id = p.family_id
    LEFT JOIN stations s ON s.id = p.station_id
    WHERE p.id = ?`);
  const getProduct = (id: number): ProductRow => {
    const p = productStmt.get(id) as ProductRow | undefined;
    if (!p) throw new DomainError(400, `Prodotto ${id} inesistente`);
    return p;
  };
  const kitchenStation = (p: ProductRow) => (p.station_id && p.station_enabled ? p.station_id : null);

  return db.transaction(() => {
    const planned: PlannedLine[] = [];
    // unità da scaricare per magazzino: "p:<id>" prodotto, "s:<id>" magazzino condiviso
    const consumption = new Map<string, { units: number; label: string }>();
    const consume = (p: ProductRow, pieces: number) => {
      if (p.stock_mode === 'unlimited') return;
      const key = p.stock_mode === 'own' ? `p:${p.id}` : `s:${p.storage_id}`;
      const c = consumption.get(key) ?? { units: 0, label: p.name };
      c.units += pieces * p.stock_units;
      consumption.set(key, c);
    };

    for (const line of input.lines) {
      if (!Number.isInteger(line.qty) || line.qty <= 0) throw new DomainError(400, 'Quantità non valida');
      const gift = !!line.gift;
      const note = (line.note ?? '').trim();

      if (isMenuLine(line)) {
        const menu = db.prepare('SELECT * FROM menus WHERE id = ?').get(line.menuId) as
          | { id: number; name: string; price_cents: number }
          | undefined;
        if (!menu) throw new DomainError(400, `Menù ${line.menuId} inesistente`);
        const components = db
          .prepare('SELECT * FROM menu_components WHERE menu_id = ? ORDER BY sort, id')
          .all(menu.id) as { id: number; name: string; choices: number }[];
        const parentIndex = planned.length;
        planned.push({
          parentIndex: null, productId: null, menuId: menu.id, name: menu.name, familyName: 'Menù',
          qty: line.qty, unitPriceCents: menu.price_cents, gift, note, stationId: null,
        });
        for (const comp of components) {
          const chosen = line.components.find((c) => c.componentId === comp.id)?.productIds ?? [];
          if (chosen.length !== comp.choices) {
            throw new DomainError(400, `${menu.name}: scegliere ${comp.choices} per "${comp.name}"`);
          }
          const allowed = new Set(
            (db.prepare('SELECT product_id FROM menu_component_products WHERE component_id = ?').all(comp.id) as {
              product_id: number;
            }[]).map((r) => r.product_id),
          );
          const counts = new Map<number, number>();
          for (const pid of chosen) {
            if (!allowed.has(pid)) throw new DomainError(400, `${menu.name}: scelta non valida per "${comp.name}"`);
            counts.set(pid, (counts.get(pid) ?? 0) + 1);
          }
          for (const [pid, n] of counts) {
            const p = getProduct(pid);
            const pieces = n * line.qty;
            consume(p, pieces);
            planned.push({
              parentIndex, productId: p.id, menuId: null, name: p.name, familyName: p.family_name,
              qty: pieces, unitPriceCents: 0, gift, note: '', stationId: kitchenStation(p),
            });
          }
        }
      } else {
        const p = getProduct(line.productId);
        let price = p.price_cents;
        if (price === null) {
          if (line.priceCents === undefined || !Number.isInteger(line.priceCents) || line.priceCents < 0) {
            throw new DomainError(400, `${p.name}: indicare il prezzo`);
          }
          price = line.priceCents;
        }
        consume(p, line.qty);
        planned.push({
          parentIndex: null, productId: p.id, menuId: null, name: p.name, familyName: p.family_name,
          qty: line.qty, unitPriceCents: price, gift, note, stationId: kitchenStation(p),
        });
      }
    }

    // Verifica disponibilità prima di scrivere qualunque cosa.
    const shortages: string[] = [];
    for (const [key, c] of consumption) {
      const [kind, id] = key.split(':');
      const row = (
        kind === 'p'
          ? db.prepare('SELECT stock_qty AS qty FROM products WHERE id = ?').get(Number(id))
          : db.prepare('SELECT quantity AS qty, name FROM storages WHERE id = ?').get(Number(id))
      ) as { qty: number; name?: string };
      if (row.qty + 1e-9 < c.units) {
        shortages.push(`${kind === 'p' ? c.label : row.name}: disponibili ${Math.floor(row.qty + 1e-9)}`);
      }
    }
    if (shortages.length) throw new DomainError(409, `Quantità insufficiente — ${shortages.join('; ')}`);

    const subtotal = planned
      .filter((l) => l.parentIndex === null && !l.gift)
      .reduce((sum, l) => sum + l.qty * l.unitPriceCents, 0);
    const discount = computeDiscount(subtotal, input.discount);
    const total = subtotal - discount;

    const method = input.payment.method;
    let paid = Math.round(input.payment.paidCents);
    if (method === 'contanti') {
      if (paid === 0) paid = total;
      if (paid < total) throw new DomainError(400, 'Importo ricevuto inferiore al totale');
    } else {
      paid = total;
    }

    const settingsRow = db.prepare("SELECT value FROM settings WHERE key = 'requireTable'").get() as
      | { value: string }
      | undefined;
    const tableLabel = (input.tableLabel ?? '').trim();
    if (settingsRow && JSON.parse(settingsRow.value) && !tableLabel && !input.takeaway) {
      throw new DomainError(400, 'Indicare tavolo o nome, oppure asporto');
    }

    const { next } = db
      .prepare('SELECT COALESCE(MAX(number), 0) + 1 AS next FROM orders WHERE closure_id IS NULL')
      .get() as { next: number };

    const orderId = Number(
      db
        .prepare(
          `INSERT INTO orders (number, operator_id, till_id, table_label, takeaway, note,
             subtotal_cents, discount_cents, total_cents, paid_cents, payment_method)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(next, operatorId, input.tillId, tableLabel, input.takeaway ? 1 : 0, (input.note ?? '').trim(),
          subtotal, discount, total, paid, method).lastInsertRowid,
    );

    const insertLine = db.prepare(
      `INSERT INTO order_lines (order_id, parent_line_id, product_id, menu_id, name, family_name, qty,
         unit_price_cents, gift, note, station_id, kitchen_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const ids: number[] = [];
    for (const l of planned) {
      const parentId = l.parentIndex === null ? null : ids[l.parentIndex];
      ids.push(
        Number(
          insertLine.run(orderId, parentId, l.productId, l.menuId, l.name, l.familyName, l.qty, l.unitPriceCents,
            l.gift ? 1 : 0, l.note, l.stationId, l.stationId ? 'pending' : 'none').lastInsertRowid,
        ),
      );
    }

    for (const [key, c] of consumption) {
      applyStock(db, key, -c.units, 'vendita', orderId);
    }
    return orderId;
  })();
}

function applyStock(db: DB, key: string, delta: number, reason: string, orderId: number | null) {
  const [kind, idStr] = key.split(':');
  const id = Number(idStr);
  if (kind === 'p') {
    db.prepare('UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?').run(delta, id);
    db.prepare('INSERT INTO stock_movements (product_id, delta, reason, order_id) VALUES (?, ?, ?, ?)').run(
      id, delta, reason, orderId);
  } else {
    db.prepare('UPDATE storages SET quantity = quantity + ? WHERE id = ?').run(delta, id);
    db.prepare('INSERT INTO stock_movements (storage_id, delta, reason, order_id) VALUES (?, ?, ?, ?)').run(
      id, delta, reason, orderId);
  }
}

/** Rettifica manuale di magazzino (carico/scarico/inventario). */
export function adjustStock(db: DB, target: { productId?: number; storageId?: number }, setTo: number) {
  db.transaction(() => {
    if (target.productId) {
      const r = db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(target.productId) as
        | { stock_qty: number }
        | undefined;
      if (!r) throw new DomainError(404, 'Prodotto inesistente');
      applyStock(db, `p:${target.productId}`, setTo - r.stock_qty, 'rettifica', null);
    } else if (target.storageId) {
      const r = db.prepare('SELECT quantity FROM storages WHERE id = ?').get(target.storageId) as
        | { quantity: number }
        | undefined;
      if (!r) throw new DomainError(404, 'Magazzino inesistente');
      applyStock(db, `s:${target.storageId}`, setTo - r.quantity, 'rettifica', null);
    }
  })();
}

/**
 * Storno totale: segna l'ordine come annullato e restituisce al magazzino
 * esattamente quanto era stato scalato. Restituisce le stazioni che avevano
 * ancora righe da preparare (da avvisare).
 */
export function voidOrder(db: DB, orderId: number, operatorId: number, reason: string): number[] {
  return db.transaction(() => {
    const o = db.prepare('SELECT status, closure_id FROM orders WHERE id = ?').get(orderId) as
      | { status: string; closure_id: number | null }
      | undefined;
    if (!o) throw new DomainError(404, 'Ordine inesistente');
    if (o.status === 'voided') throw new DomainError(409, 'Ordine già stornato');
    if (o.closure_id !== null) throw new DomainError(409, 'Ordine già incluso in una chiusura di cassa');
    if (!reason.trim()) throw new DomainError(400, 'Indicare il motivo dello storno');

    const moves = db
      .prepare(
        `SELECT product_id, storage_id, SUM(delta) AS delta FROM stock_movements
         WHERE order_id = ? GROUP BY product_id, storage_id`,
      )
      .all(orderId) as { product_id: number | null; storage_id: number | null; delta: number }[];
    for (const m of moves) {
      const key = m.product_id ? `p:${m.product_id}` : `s:${m.storage_id}`;
      applyStock(db, key, -m.delta, 'storno', orderId);
    }

    const stations = (
      db
        .prepare(
          "SELECT DISTINCT station_id FROM order_lines WHERE order_id = ? AND kitchen_status = 'pending' AND station_id IS NOT NULL",
        )
        .all(orderId) as { station_id: number }[]
    ).map((r) => r.station_id);

    db.prepare(
      `UPDATE orders SET status = 'voided', voided_at = datetime('now', 'localtime'), voided_by = ?, void_reason = ?
       WHERE id = ?`,
    ).run(operatorId, reason.trim(), orderId);
    db.prepare("UPDATE order_lines SET kitchen_status = 'none' WHERE order_id = ?").run(orderId);
    return stations;
  })();
}
