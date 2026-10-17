import type { Order, OrderLine, Settings } from '../../shared/types.js';
import { PrintDoc } from './doc.js';

export const euro = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');
const time = (iso: string) => iso.slice(11, 16);
const date = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

function orderTag(o: Order): string {
  if (o.takeaway) return o.tableLabel ? `ASPORTO · ${o.tableLabel}` : 'ASPORTO';
  return o.tableLabel ? `Tavolo/Nome: ${o.tableLabel}` : '';
}

/** Scontrino riepilogativo per il cliente (non fiscale). */
export function receiptDoc(o: Order, s: Settings): PrintDoc {
  const d = new PrintDoc();
  d.text(s.eventName, { align: 'center', bold: true, big: true });
  if (s.receiptHeader) d.text(s.receiptHeader, { align: 'center' });
  d.rule();
  d.row(`Ordine n. ${o.number}`, `${date(o.createdAt)} ${time(o.createdAt)}`, true);
  const tag = orderTag(o);
  if (tag) d.text(tag);
  d.rule();
  const top = o.lines.filter((l) => l.parentLineId === null);
  for (const l of top) {
    const amount = l.gift ? 'OMAGGIO' : euro(l.qty * l.unitPriceCents);
    d.row(`${l.qty} x ${l.name}`, amount);
    if (l.qty > 1 && !l.gift) d.text(`    (${euro(l.unitPriceCents)} cad.)`);
    for (const sub of o.lines.filter((x) => x.parentLineId === l.id)) d.text(`    - ${sub.qty} ${sub.name}`);
    if (l.note) d.text(`    * ${l.note}`);
  }
  d.rule();
  if (o.discountCents > 0) {
    d.row('Subtotale', euro(o.subtotalCents));
    d.row('Sconto', '-' + euro(o.discountCents));
  }
  d.text(`TOTALE € ${euro(o.totalCents)}`, { align: 'right', bold: true, big: true });
  if (o.paymentMethod === 'contanti' && o.paidCents > o.totalCents) {
    d.row('Contanti', euro(o.paidCents));
    d.row('Resto', euro(o.paidCents - o.totalCents));
  } else {
    d.row('Pagamento', o.paymentMethod);
  }
  d.rule();
  d.text('Documento non fiscale', { align: 'center' });
  if (s.receiptFooter) d.text(s.receiptFooter, { align: 'center' });
  d.feed(2).cut();
  return d;
}

/** Ticket di ritiro: il numero grande da mostrare al banco. */
export function pickupDoc(o: Order, s: Settings): PrintDoc {
  const d = new PrintDoc();
  d.text(s.eventName, { align: 'center', bold: true });
  d.text('TICKET RITIRO', { align: 'center' });
  d.text(String(o.number), { align: 'center', bold: true, huge: true });
  const tag = orderTag(o);
  if (tag) d.text(tag, { align: 'center', bold: true });
  d.text(time(o.createdAt), { align: 'center' });
  d.feed(2).cut();
  return d;
}

function comandaHeader(d: PrintDoc, o: Order, stationName: string) {
  d.text(stationName.toUpperCase(), { align: 'center', bold: true, big: true });
  d.row(`Ordine n. ${o.number}`, time(o.createdAt), true);
  const tag = orderTag(o);
  if (tag) d.text(tag, { bold: true, big: true });
  d.rule();
}

/**
 * Comande per un reparto. I prodotti in modalità "separate" escono
 * su un foglietto per ogni pezzo, gli altri tutti insieme.
 */
export function comandaDocs(
  o: Order,
  stationName: string,
  lines: OrderLine[],
  separateIds: Set<number>,
  s: Settings,
): PrintDoc[] {
  const docs: PrintDoc[] = [];
  const grouped = lines.filter((l) => !l.productId || !separateIds.has(l.productId));
  const separate = lines.filter((l) => l.productId && separateIds.has(l.productId));
  const menuName = (l: OrderLine) => o.lines.find((m) => m.id === l.parentLineId)?.name;

  if (grouped.length) {
    const d = new PrintDoc();
    comandaHeader(d, o, stationName);
    for (const l of grouped) {
      const price = s.pricesOnComande && !l.parentLineId ? euro(l.qty * l.unitPriceCents) : '';
      d.row(`${l.qty} x ${l.name}`, price, true);
      const m = menuName(l);
      if (m) d.text(`    (${m})`);
      if (l.note) d.text(`    * ${l.note}`, { bold: true });
    }
    if (o.note) d.rule().text(`NOTE: ${o.note}`, { bold: true });
    d.feed(2).cut();
    docs.push(d);
  }
  for (const l of separate) {
    for (let i = 0; i < l.qty; i++) {
      const d = new PrintDoc();
      comandaHeader(d, o, stationName);
      d.text(`1 x ${l.name}`, { bold: true, big: true });
      if (l.note) d.text(`* ${l.note}`, { bold: true });
      d.feed(2).cut();
      docs.push(d);
    }
  }
  return docs;
}

export function voidNoticeDoc(o: Order, stationName: string): PrintDoc {
  const d = new PrintDoc();
  d.text(stationName.toUpperCase(), { align: 'center', bold: true });
  d.text('ORDINE ANNULLATO', { align: 'center', bold: true, big: true });
  d.text(`n. ${o.number}`, { align: 'center', bold: true, huge: true });
  if (o.voidReason) d.text(`Motivo: ${o.voidReason}`);
  d.text('NON PREPARARE', { align: 'center', bold: true });
  d.feed(2).cut();
  return d;
}

export function testDoc(printerName: string): PrintDoc {
  return new PrintDoc()
    .text('Prova di stampa', { align: 'center', bold: true, big: true })
    .text(printerName, { align: 'center' })
    .rule()
    .text('àèéìòù € ÀÈÌÒÙ')
    .row('Prodotto di esempio', '12,50')
    .text('42', { align: 'center', huge: true, bold: true })
    .feed(2)
    .cut();
}
