import type { DB } from '../db.js';
import { getOrder, getSettings } from '../repo.js';
import type { PrintQueue } from './queue.js';
import { comandaDocs, pickupDoc, receiptDoc, voidNoticeDoc } from './templates.js';

export type PrintWhat = 'all' | 'receipt' | 'comande';

/** Accoda le stampe di un ordine: scontrino e ritiro alla cassa, comande ai reparti. */
export function printOrder(db: DB, queue: PrintQueue, orderId: number, what: PrintWhat = 'all') {
  const order = getOrder(db, orderId);
  if (!order) return;
  const settings = getSettings(db);

  if (what !== 'comande') {
    const till = db.prepare('SELECT receipt_printer_id FROM tills WHERE id = ?').get(order.tillId) as
      | { receipt_printer_id: number | null }
      | undefined;
    const printerId = till?.receipt_printer_id ?? null;
    if (settings.printReceipt) queue.enqueue(printerId, 'scontrino', receiptDoc(order, settings), orderId);
    if (settings.printPickupTicket) queue.enqueue(printerId, 'ritiro', pickupDoc(order, settings), orderId);
  }

  if (what !== 'receipt') {
    const stations = db.prepare('SELECT id, name, printer_id FROM stations WHERE enabled = 1').all() as {
      id: number;
      name: string;
      printer_id: number | null;
    }[];
    const separateIds = new Set(
      (db.prepare("SELECT id FROM products WHERE print_mode = 'separate'").all() as { id: number }[]).map((r) => r.id),
    );
    for (const st of stations) {
      const lines = order.lines.filter((l) => l.stationId === st.id);
      if (!lines.length || !st.printer_id) continue;
      for (const doc of comandaDocs(order, st.name, lines, separateIds, settings)) {
        queue.enqueue(st.printer_id, 'comanda', doc, orderId);
      }
    }
  }
}

export function printVoidNotices(db: DB, queue: PrintQueue, orderId: number, stationIds: number[]) {
  const order = getOrder(db, orderId);
  if (!order) return;
  for (const id of stationIds) {
    const st = db.prepare('SELECT name, printer_id FROM stations WHERE id = ?').get(id) as
      | { name: string; printer_id: number | null }
      | undefined;
    if (st?.printer_id) queue.enqueue(st.printer_id, 'storno', voidNoticeDoc(order, st.name), orderId);
  }
}
