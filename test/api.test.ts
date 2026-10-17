import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../server/app.js';
import { openDb, type DB } from '../server/db.js';
import type { Catalog, Order, Stats } from '../shared/types.js';

let db: DB;
let dataDir: string;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let cookie = '';

async function call<T = any>(method: string, url: string, payload?: unknown, expectStatus = 200): Promise<T> {
  const res = await app.inject({ method: method as 'GET', url, payload: payload as object, headers: { cookie } });
  if (res.statusCode !== expectStatus) throw new Error(`${method} ${url} -> ${res.statusCode}: ${res.body}`);
  const setCookie = res.headers['set-cookie'];
  if (setCookie) cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];
  return res.headers['content-type']?.includes('json') ? res.json() : (res.body as T);
}

async function seed() {
  await call('POST', '/api/setup', { name: 'Admin', pin: '1234' });
  const printer = await call('POST', '/api/admin/printers', { name: 'Anteprima', kind: 'file', address: '', widthChars: 42 });
  const till = await call('POST', '/api/admin/tills', { name: 'Cassa 1', receiptPrinterId: printer.id });
  const kitchen = await call('POST', '/api/admin/stations', { name: 'Cucina', printerId: printer.id, enabled: true, sort: 0 });
  const fam = await call('POST', '/api/admin/families', { name: 'Tigelle', color: '#ff8800', visible: true, sort: 0 });
  const storage = await call('POST', '/api/admin/storages', { name: 'Impasto tigelle', quantity: 5 });
  const base = {
    familyId: fam.id, stationId: kitchen.id, stockQty: 0, storageId: null, stockUnits: 1, lowStock: 0,
    printMode: 'grouped', visible: true, menuOnly: false, sort: 0,
  };
  const salame = await call('POST', '/api/admin/products', {
    ...base, name: 'Tigella salame', priceCents: 150, stockMode: 'shared', storageId: storage.id,
  });
  const nutella = await call('POST', '/api/admin/products', {
    ...base, name: 'Tigella nutella', priceCents: 100, stockMode: 'shared', storageId: storage.id,
  });
  const acqua = await call('POST', '/api/admin/products', {
    ...base, stationId: null, name: 'Acqua', priceCents: 100, stockMode: 'own', stockQty: 3,
  });
  const libero = await call('POST', '/api/admin/products', {
    ...base, stationId: null, name: 'Generico', priceCents: null, stockMode: 'unlimited',
  });
  const menu = await call('POST', '/api/admin/menus', {
    name: 'Menù tigelle', priceCents: 500, color: '#00aa00', visible: true, sort: 0,
    components: [{ name: 'Tigelle', choices: 2, productIds: [salame.id, nutella.id] }, { name: 'Bere', choices: 1, productIds: [acqua.id] }],
  });
  const catalog = await call<Catalog>('GET', '/api/catalog');
  return { till: till.id, kitchen: kitchen.id, salame: salame.id, nutella: nutella.id, acqua: acqua.id, libero: libero.id, storage: storage.id, menu: catalog.menus.find((m) => m.id === menu.id)! };
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cassa-test-'));
  db = openDb(':memory:');
  ({ app } = await buildApp({ db, dataDir }));
  cookie = '';
});
afterEach(async () => {
  await app.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('autenticazione', () => {
  it('richiede accesso e blocca la seconda configurazione', async () => {
    await call('GET', '/api/catalog', undefined, 401);
    await call('POST', '/api/setup', { name: 'Admin', pin: '1234' });
    await call('POST', '/api/setup', { name: 'Altro', pin: '1234' }, 409);
    await call('GET', '/api/catalog');
  });

  it('la cucina non può vendere né amministrare', async () => {
    await call('POST', '/api/setup', { name: 'Admin', pin: '1234' });
    const op = await call('POST', '/api/admin/operators', { name: 'Cuoco', role: 'cucina', active: true, pin: '5555' });
    await call('POST', '/api/auth/logout');
    await call('POST', '/api/auth/login', { operatorId: op.id, pin: '0000' }, 401);
    await call('POST', '/api/auth/login', { operatorId: op.id, pin: '5555' });
    await call('GET', '/api/catalog');
    await call('GET', '/api/admin/products', undefined, 403);
    await call('POST', '/api/orders', { tillId: 1, lines: [{ productId: 1, qty: 1 }], payment: { method: 'contanti', paidCents: 0 } }, 403);
  });
});

describe('ordini', () => {
  it('calcola totali, sconto, resto e scala il magazzino condiviso', async () => {
    const s = await seed();
    const order = await call<Order>('POST', '/api/orders', {
      tillId: s.till,
      tableLabel: '12',
      lines: [
        { productId: s.salame, qty: 2 },
        { productId: s.nutella, qty: 1, gift: true },
        { productId: s.libero, qty: 1, priceCents: 250 },
      ],
      discount: { type: 'percent', value: 10 },
      payment: { method: 'contanti', paidCents: 1000 },
    });
    expect(order.number).toBe(1);
    expect(order.subtotalCents).toBe(550); // 2*150 + 250, omaggio escluso
    expect(order.discountCents).toBe(55);
    expect(order.totalCents).toBe(495);
    expect(order.paidCents).toBe(1000);

    const catalog = await call<Catalog>('GET', '/api/catalog');
    expect(catalog.storages.find((x) => x.id === s.storage)!.quantity).toBe(2);
    expect(catalog.products.find((p) => p.id === s.salame)!.available).toBe(2);
  });

  it('rifiuta un ordine senza disponibilità e non scala nulla', async () => {
    const s = await seed();
    const res = await app.inject({
      method: 'POST', url: '/api/orders', headers: { cookie },
      payload: { tillId: s.till, lines: [{ productId: s.acqua, qty: 1 }, { productId: s.salame, qty: 6 }], payment: { method: 'carta', paidCents: 0 } },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('Impasto tigelle');
    const catalog = await call<Catalog>('GET', '/api/catalog');
    expect(catalog.products.find((p) => p.id === s.acqua)!.stockQty).toBe(3);
  });

  it('richiede il prezzo per i prodotti a prezzo libero e contanti sufficienti', async () => {
    const s = await seed();
    await call('POST', '/api/orders', { tillId: s.till, lines: [{ productId: s.libero, qty: 1 }], payment: { method: 'carta', paidCents: 0 } }, 400);
    await call('POST', '/api/orders', { tillId: s.till, lines: [{ productId: s.acqua, qty: 2 }], payment: { method: 'contanti', paidCents: 150 } }, 400);
  });

  it('gestisce i menù: scelte obbligatorie, righe figlie, magazzino', async () => {
    const s = await seed();
    const [tig, bere] = s.menu.components;
    await call('POST', '/api/orders', {
      tillId: s.till, payment: { method: 'carta', paidCents: 0 },
      lines: [{ menuId: s.menu.id, qty: 1, components: [{ componentId: tig.id, productIds: [s.salame] }, { componentId: bere.id, productIds: [s.acqua] }] }],
    }, 400);
    const order = await call<Order>('POST', '/api/orders', {
      tillId: s.till, payment: { method: 'carta', paidCents: 0 },
      lines: [{ menuId: s.menu.id, qty: 1, components: [{ componentId: tig.id, productIds: [s.salame, s.salame] }, { componentId: bere.id, productIds: [s.acqua] }] }],
    });
    expect(order.totalCents).toBe(500);
    const menuLine = order.lines.find((l) => l.menuId)!;
    const children = order.lines.filter((l) => l.parentLineId === menuLine.id);
    expect(children.map((c) => [c.name, c.qty])).toEqual([['Tigella salame', 2], ['Acqua', 1]]);
    expect(children.find((c) => c.name === 'Tigella salame')!.kitchenStatus).toBe('pending');
    const catalog = await call<Catalog>('GET', '/api/catalog');
    expect(catalog.storages[0].quantity).toBe(3);
  });

  it('lo storno ripristina il magazzino e toglie le righe dalla cucina', async () => {
    const s = await seed();
    const order = await call<Order>('POST', '/api/orders', {
      tillId: s.till, lines: [{ productId: s.salame, qty: 3 }], payment: { method: 'carta', paidCents: 0 },
    });
    expect((await call<Order[]>('GET', `/api/kitchen?station=${s.kitchen}`)).length).toBe(1);
    await call('POST', `/api/orders/${order.id}/void`, { reason: '' }, 400);
    const voided = await call<Order>('POST', `/api/orders/${order.id}/void`, { reason: 'errore cassa' });
    expect(voided.status).toBe('voided');
    await call('POST', `/api/orders/${order.id}/void`, { reason: 'di nuovo' }, 409);
    expect((await call<Order[]>('GET', `/api/kitchen?station=${s.kitchen}`)).length).toBe(0);
    const catalog = await call<Catalog>('GET', '/api/catalog');
    expect(catalog.storages[0].quantity).toBe(5);
  });

  it('la cucina segna le righe pronte', async () => {
    const s = await seed();
    const order = await call<Order>('POST', '/api/orders', {
      tillId: s.till, lines: [{ productId: s.salame, qty: 1 }, { productId: s.acqua, qty: 1 }], payment: { method: 'carta', paidCents: 0 },
    });
    const kitchenLine = order.lines.find((l) => l.stationId === s.kitchen)!;
    expect(order.lines.find((l) => l.productId === s.acqua)!.kitchenStatus).toBe('none');
    await call('POST', `/api/kitchen/orders/${order.id}`, { station: s.kitchen, status: 'ready' });
    const k = await call<Order[]>('GET', `/api/kitchen?station=${s.kitchen}`);
    expect(k[0].lines.find((l) => l.id === kitchenLine.id)!.kitchenStatus).toBe('ready');
    await call('POST', `/api/kitchen/lines/${kitchenLine.id}`, { status: 'delivered' });
    expect((await call<Order[]>('GET', `/api/kitchen?station=${s.kitchen}`)).length).toBe(0);
  });
});

describe('statistiche e chiusura', () => {
  it('chiude la giornata, congela i totali e riparte da 1', async () => {
    const s = await seed();
    const pay = { method: 'contanti', paidCents: 0 };
    await call('POST', '/api/orders', { tillId: s.till, lines: [{ productId: s.salame, qty: 2 }], payment: pay });
    const o2 = await call<Order>('POST', '/api/orders', { tillId: s.till, lines: [{ productId: s.acqua, qty: 1 }], payment: pay });
    await call('POST', `/api/orders/${o2.id}/void`, { reason: 'prova' });
    const stats = await call<Stats>('GET', '/api/stats');
    expect(stats.orders).toBe(1);
    expect(stats.voidedOrders).toBe(1);
    expect(stats.netCents).toBe(300);
    const csv = await call<string>('GET', '/api/stats.csv');
    expect(csv).toContain('"Tigella salame";2;0;3,00');

    const { id } = await call('POST', '/api/closures');
    const closures = await call('GET', '/api/closures');
    expect(closures[0].totals.netCents).toBe(300);
    expect((await call<Stats>('GET', '/api/stats')).orders).toBe(0);
    expect((await call<Stats>('GET', `/api/stats?closure=${id}`)).netCents).toBe(300);
    await call('POST', `/api/orders/${o2.id}/void`, { reason: 'dopo chiusura' }, 409);
    const o3 = await call<Order>('POST', '/api/orders', { tillId: s.till, lines: [{ productId: s.acqua, qty: 1 }], payment: pay });
    expect(o3.number).toBe(1);
  });
});

describe('stampa', () => {
  it('produce scontrino, ticket ritiro e comanda in anteprima', async () => {
    const s = await seed();
    await call('POST', '/api/orders', {
      tillId: s.till, tableLabel: 'Rossi', lines: [{ productId: s.salame, qty: 2, note: 'senza burro' }], payment: { method: 'contanti', paidCents: 500 },
    });
    // la coda lavora in background
    await new Promise((r) => setTimeout(r, 100));
    const dir = path.join(dataDir, 'anteprime-stampa');
    const files = fs.readdirSync(dir).sort();
    expect(files.length).toBe(3);
    const all = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    expect(all).toContain('TOTALE € 3,00');
    expect(all).toContain('Resto');
    expect(all).toContain('2 x Tigella salame');
    expect(all).toContain('* senza burro');
    const jobs = await call('GET', '/api/print-jobs');
    expect(jobs.every((j: { status: string }) => j.status === 'done')).toBe(true);
  });
});
