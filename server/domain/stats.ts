import type { DB } from '../db.js';
import type { Stats } from '../../shared/types.js';
import { DomainError } from './orders.js';

/**
 * Statistiche di vendita. `closureId` null = giornata in corso (ordini non ancora chiusi);
 * `all` = tutto lo storico.
 */
export function computeStats(db: DB, scope: { closureId: number | null } | 'all'): Stats {
  const where = scope === 'all' ? '1 = 1' : scope.closureId === null ? 'o.closure_id IS NULL' : 'o.closure_id = ?';
  const p = scope === 'all' || scope.closureId === null ? [] : [scope.closureId];
  const ok = `${where} AND o.status = 'ok'`;

  const head = db
    .prepare(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(subtotal_cents), 0) AS gross,
              COALESCE(SUM(discount_cents), 0) AS discount, COALESCE(SUM(total_cents), 0) AS net
       FROM orders o WHERE ${ok}`,
    )
    .get(...p) as { orders: number; gross: number; discount: number; net: number };
  const voided = (db.prepare(`SELECT COUNT(*) AS n FROM orders o WHERE ${where} AND o.status = 'voided'`).get(...p) as {
    n: number;
  }).n;

  // Righe di primo livello (prodotti singoli e menù); i prodotti dentro ai menù
  // sono conteggiati a parte con prezzo 0, così le quantità restano utili per la cucina.
  const byProduct = db
    .prepare(
      `SELECT l.name, l.family_name AS familyName,
              SUM(l.qty) AS qty,
              SUM(CASE WHEN l.gift = 1 THEN l.qty ELSE 0 END) AS gifts,
              SUM(CASE WHEN l.gift = 1 THEN 0 ELSE l.qty * l.unit_price_cents END) AS cents
       FROM order_lines l JOIN orders o ON o.id = l.order_id
       WHERE ${ok}
       GROUP BY l.name, l.family_name
       ORDER BY l.family_name, qty DESC`,
    )
    .all(...p) as Stats['byProduct'];

  const giftCents = (db
    .prepare(
      `SELECT COALESCE(SUM(l.qty * l.unit_price_cents), 0) AS c
       FROM order_lines l JOIN orders o ON o.id = l.order_id
       WHERE ${ok} AND l.gift = 1 AND l.parent_line_id IS NULL`,
    )
    .get(...p) as { c: number }).c;

  const byFamily = db
    .prepare(
      `SELECT l.family_name AS familyName, SUM(l.qty) AS qty,
              SUM(CASE WHEN l.gift = 1 THEN 0 ELSE l.qty * l.unit_price_cents END) AS cents
       FROM order_lines l JOIN orders o ON o.id = l.order_id
       WHERE ${ok} AND l.parent_line_id IS NULL
       GROUP BY l.family_name ORDER BY cents DESC`,
    )
    .all(...p) as Stats['byFamily'];

  const byPayment = db
    .prepare(
      `SELECT payment_method AS method, COUNT(*) AS orders, SUM(total_cents) AS cents
       FROM orders o WHERE ${ok} GROUP BY payment_method ORDER BY cents DESC`,
    )
    .all(...p) as Stats['byPayment'];

  const byOperator = db
    .prepare(
      `SELECT COALESCE(op.name, '—') AS operatorName, COUNT(*) AS orders, SUM(o.total_cents) AS cents
       FROM orders o LEFT JOIN operators op ON op.id = o.operator_id
       WHERE ${ok} GROUP BY op.name ORDER BY cents DESC`,
    )
    .all(...p) as Stats['byOperator'];

  return {
    orders: head.orders,
    voidedOrders: voided,
    grossCents: head.gross,
    discountCents: head.discount,
    netCents: head.net,
    giftCents,
    byPayment,
    byProduct,
    byFamily,
    byOperator,
  };
}

/** Chiusura di cassa: congela le statistiche della giornata e azzera la numerazione. */
export function closeDay(db: DB, operatorId: number): number {
  return db.transaction(() => {
    const open = db.prepare('SELECT COUNT(*) AS n FROM orders WHERE closure_id IS NULL').get() as { n: number };
    if (open.n === 0) throw new DomainError(409, 'Nessun ordine da chiudere');
    const totals = computeStats(db, { closureId: null });
    const id = Number(
      db.prepare('INSERT INTO closures (operator_id, totals_json) VALUES (?, ?)').run(operatorId, JSON.stringify(totals))
        .lastInsertRowid,
    );
    db.prepare('UPDATE orders SET closure_id = ? WHERE closure_id IS NULL').run(id);
    return id;
  })();
}

export function statsToCsv(s: Stats): string {
  const euro = (c: number) => (c / 100).toFixed(2).replace('.', ',');
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const rows = [
    ['Famiglia', 'Prodotto', 'Quantità', 'Di cui omaggio', 'Incasso (€)'].join(';'),
    ...s.byProduct.map((r) => [esc(r.familyName), esc(r.name), r.qty, r.gifts, euro(r.cents)].join(';')),
    '',
    ['Ordini', s.orders].join(';'),
    ['Stornati', s.voidedOrders].join(';'),
    ['Lordo', euro(s.grossCents)].join(';'),
    ['Sconti', euro(s.discountCents)].join(';'),
    ['Netto', euro(s.netCents)].join(';'),
    ['Omaggi (valore)', euro(s.giftCents)].join(';'),
  ];
  // BOM per far riconoscere UTF-8 a Excel
  return '﻿' + rows.join('\r\n');
}
