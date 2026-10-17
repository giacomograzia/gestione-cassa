// Tipi condivisi tra server e interfaccia web.

export type Role = 'admin' | 'cassa' | 'cucina';
export type StockMode = 'unlimited' | 'own' | 'shared';
export type PrintMode = 'grouped' | 'separate';
export type PaymentMethod = 'contanti' | 'carta' | 'altro';
export type KitchenStatus = 'none' | 'pending' | 'ready' | 'delivered';
export type PrinterKind = 'network' | 'cups' | 'file';

export interface Operator {
  id: number;
  name: string;
  role: Role;
  active: boolean;
}

export interface Settings {
  eventName: string;
  receiptHeader: string;
  receiptFooter: string;
  /** Stampa lo scontrino riepilogativo per il cliente. */
  printReceipt: boolean;
  /** Stampa il ticket di ritiro con il numero d'ordine grande. */
  printPickupTicket: boolean;
  /** Mostra i prezzi sulle comande di cucina. */
  pricesOnComande: boolean;
  /** Obbligo di indicare tavolo/nome prima di confermare. */
  requireTable: boolean;
}

export interface Printer {
  id: number;
  name: string;
  kind: PrinterKind;
  address: string;
  widthChars: number;
}

export interface Till {
  id: number;
  name: string;
  receiptPrinterId: number | null;
}

export interface Station {
  id: number;
  name: string;
  printerId: number | null;
  enabled: boolean;
  sort: number;
}

export interface Family {
  id: number;
  name: string;
  color: string;
  visible: boolean;
  sort: number;
}

export interface Storage {
  id: number;
  name: string;
  quantity: number;
}

export interface Product {
  id: number;
  familyId: number;
  stationId: number | null;
  name: string;
  priceCents: number | null;
  stockMode: StockMode;
  stockQty: number;
  storageId: number | null;
  stockUnits: number;
  lowStock: number;
  printMode: PrintMode;
  visible: boolean;
  menuOnly: boolean;
  sort: number;
  /** Pezzi ancora vendibili; null = illimitato. Calcolato dal server. */
  available: number | null;
}

export interface MenuComponent {
  id: number;
  name: string;
  choices: number;
  sort: number;
  productIds: number[];
}

export interface Menu {
  id: number;
  name: string;
  priceCents: number;
  color: string;
  visible: boolean;
  sort: number;
  components: MenuComponent[];
}

export interface Catalog {
  families: Family[];
  products: Product[];
  menus: Menu[];
  stations: Station[];
  storages: Storage[];
}

// ---- Ordini ----

export interface NewOrderProductLine {
  productId: number;
  qty: number;
  gift?: boolean;
  note?: string;
  /** Obbligatorio solo per i prodotti a prezzo libero. */
  priceCents?: number;
}

export interface NewOrderMenuLine {
  menuId: number;
  qty: number;
  gift?: boolean;
  note?: string;
  /** Per ogni componente, i prodotti scelti (esattamente `choices`). */
  components: { componentId: number; productIds: number[] }[];
}

export type NewOrderLine = NewOrderProductLine | NewOrderMenuLine;

export interface NewOrder {
  tillId: number;
  tableLabel?: string;
  takeaway?: boolean;
  note?: string;
  lines: NewOrderLine[];
  discount?: { type: 'percent' | 'amount'; value: number };
  payment: { method: PaymentMethod; paidCents: number };
}

export interface OrderLine {
  id: number;
  parentLineId: number | null;
  productId: number | null;
  menuId: number | null;
  name: string;
  familyName: string;
  qty: number;
  unitPriceCents: number;
  gift: boolean;
  note: string;
  stationId: number | null;
  kitchenStatus: KitchenStatus;
  readyAt: string | null;
}

export interface Order {
  id: number;
  number: number;
  createdAt: string;
  operatorId: number | null;
  operatorName: string | null;
  tillId: number | null;
  tableLabel: string;
  takeaway: boolean;
  note: string;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  paidCents: number;
  paymentMethod: PaymentMethod;
  status: 'ok' | 'voided';
  voidedAt: string | null;
  voidReason: string | null;
  closureId: number | null;
  lines: OrderLine[];
}

// ---- Statistiche ----

export interface Stats {
  orders: number;
  voidedOrders: number;
  grossCents: number;
  discountCents: number;
  netCents: number;
  giftCents: number;
  byPayment: { method: PaymentMethod; orders: number; cents: number }[];
  byProduct: { name: string; familyName: string; qty: number; gifts: number; cents: number }[];
  byFamily: { familyName: string; qty: number; cents: number }[];
  byOperator: { operatorName: string; orders: number; cents: number }[];
}

export interface Closure {
  id: number;
  createdAt: string;
  operatorName: string | null;
  totals: Stats;
}

// ---- Eventi in tempo reale (WebSocket) ----

export type RealtimeEvent =
  | { type: 'catalog' }
  | { type: 'stock' }
  | { type: 'order'; orderId: number }
  | { type: 'kitchen' }
  | { type: 'print-failed'; jobId: number; printer: string; error: string };
