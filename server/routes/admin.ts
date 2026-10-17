import type { FastifyPluginAsync } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { hashPin, requireRole } from '../auth.js';
import { backupDb } from '../db.js';
import { adjustStock, DomainError } from '../domain/orders.js';
import { parseLegacyExport, importLegacy } from '../import/legacy.js';
import { send } from '../print/queue.js';
import { testDoc } from '../print/templates.js';
import { getSettings, mapPrinter, mapStation, mapTill, saveSettings } from '../repo.js';

const idParam = z.object({ id: z.coerce.number().int() });
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const name = z.string().trim().min(1).max(80);
const optId = z.number().int().nullable();

const schemas = {
  family: z.object({ name, color, visible: z.boolean(), sort: z.number().int() }),
  storage: z.object({ name, quantity: z.number() }),
  station: z.object({ name, printerId: optId, enabled: z.boolean(), sort: z.number().int() }),
  printer: z.object({
    name,
    kind: z.enum(['network', 'cups', 'file']),
    address: z.string().trim().max(120),
    widthChars: z.number().int().min(24).max(64),
  }),
  till: z.object({ name, receiptPrinterId: optId }),
  product: z.object({
    familyId: z.number().int(),
    stationId: optId,
    name,
    priceCents: z.number().int().min(0).nullable(),
    stockMode: z.enum(['unlimited', 'own', 'shared']),
    stockQty: z.number(),
    storageId: optId,
    stockUnits: z.number().positive(),
    lowStock: z.number().int().min(0),
    printMode: z.enum(['grouped', 'separate']),
    visible: z.boolean(),
    menuOnly: z.boolean(),
    sort: z.number().int(),
  }),
  menu: z.object({
    name,
    priceCents: z.number().int().min(0),
    color,
    visible: z.boolean(),
    sort: z.number().int(),
    components: z.array(
      z.object({ name, choices: z.number().int().min(1).max(10), productIds: z.array(z.number().int()).min(1) }),
    ),
  }),
  operator: z.object({
    name: z.string().trim().min(1).max(40),
    role: z.enum(['admin', 'cassa', 'cucina']),
    active: z.boolean(),
    pin: z.string().regex(/^\d{4,8}$/, 'il PIN deve avere da 4 a 8 cifre').optional(),
  }),
};

export const adminRoutes = (ctx: AppContext): FastifyPluginAsync => async (app) => {
  const { db, broadcast } = ctx;
  app.addHook('preHandler', requireRole());
  const changed = () => broadcast({ type: 'catalog' });
  const b = (v: boolean) => (v ? 1 : 0);

  /** CRUD semplice per tabelle con colonne 1:1. */
  function crud<T extends z.ZodTypeAny>(
    route: string,
    table: string,
    schema: T,
    toRow: (v: z.infer<T>) => Record<string, unknown>,
    list: () => unknown,
  ) {
    app.get(`/${route}`, async () => list());
    app.post(`/${route}`, async (req) => {
      const row = toRow(schema.parse(req.body));
      const cols = Object.keys(row);
      const id = db
        .prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
        .run(...Object.values(row)).lastInsertRowid;
      changed();
      return { id: Number(id) };
    });
    app.put(`/${route}/:id`, async (req) => {
      const { id } = idParam.parse(req.params);
      const row = toRow(schema.parse(req.body));
      db.prepare(`UPDATE ${table} SET ${Object.keys(row).map((c) => `${c} = ?`).join(',')} WHERE id = ?`).run(
        ...Object.values(row), id);
      changed();
      return { ok: true };
    });
    app.delete(`/${route}/:id`, async (req) => {
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(idParam.parse(req.params).id);
      changed();
      return { ok: true };
    });
  }

  const all = (sql: string) => db.prepare(sql).all() as Record<string, any>[];

  crud('families', 'families', schemas.family,
    (v) => ({ name: v.name, color: v.color, visible: b(v.visible), sort: v.sort }),
    () => all('SELECT * FROM families ORDER BY sort, name'));

  crud('storages', 'storages', schemas.storage,
    (v) => ({ name: v.name, quantity: v.quantity }),
    () => all('SELECT * FROM storages ORDER BY name'));

  crud('stations', 'stations', schemas.station,
    (v) => ({ name: v.name, printer_id: v.printerId, enabled: b(v.enabled), sort: v.sort }),
    () => all('SELECT * FROM stations ORDER BY sort, name').map(mapStation));

  crud('printers', 'printers', schemas.printer,
    (v) => ({ name: v.name, kind: v.kind, address: v.address, width_chars: v.widthChars }),
    () => all('SELECT * FROM printers ORDER BY name').map(mapPrinter));

  crud('tills', 'tills', schemas.till,
    (v) => ({ name: v.name, receipt_printer_id: v.receiptPrinterId }),
    () => all('SELECT * FROM tills ORDER BY name').map(mapTill));

  crud('products', 'products', schemas.product, (v) => {
    if (v.stockMode === 'shared' && !v.storageId) throw new DomainError(400, 'Scegliere il magazzino condiviso');
    return {
      family_id: v.familyId,
      station_id: v.stationId,
      name: v.name,
      price_cents: v.priceCents,
      stock_mode: v.stockMode,
      stock_qty: v.stockQty,
      storage_id: v.stockMode === 'shared' ? v.storageId : null,
      stock_units: v.stockUnits,
      low_stock: v.lowStock,
      print_mode: v.printMode,
      visible: b(v.visible),
      menu_only: b(v.menuOnly),
      sort: v.sort,
    };
  }, () => all('SELECT * FROM products ORDER BY family_id, sort, name'));

  app.post('/stock', async (req) => {
    const body = z
      .object({ productId: z.number().int().optional(), storageId: z.number().int().optional(), setTo: z.number() })
      .parse(req.body);
    adjustStock(db, body, body.setTo);
    broadcast({ type: 'stock' });
    return { ok: true };
  });

  // ---- Menù (con componenti annidati) ----

  const saveMenu = (id: number | null, v: z.infer<typeof schemas.menu>) =>
    db.transaction(() => {
      if (id === null) {
        id = Number(
          db
            .prepare('INSERT INTO menus (name, price_cents, color, visible, sort) VALUES (?, ?, ?, ?, ?)')
            .run(v.name, v.priceCents, v.color, b(v.visible), v.sort).lastInsertRowid,
        );
      } else {
        db.prepare('UPDATE menus SET name = ?, price_cents = ?, color = ?, visible = ?, sort = ? WHERE id = ?').run(
          v.name, v.priceCents, v.color, b(v.visible), v.sort, id);
        db.prepare('DELETE FROM menu_components WHERE menu_id = ?').run(id);
      }
      v.components.forEach((c, i) => {
        const cid = db
          .prepare('INSERT INTO menu_components (menu_id, name, choices, sort) VALUES (?, ?, ?, ?)')
          .run(id, c.name, c.choices, i).lastInsertRowid;
        c.productIds.forEach((pid, j) =>
          db.prepare('INSERT INTO menu_component_products (component_id, product_id, sort) VALUES (?, ?, ?)').run(
            cid, pid, j));
      });
      return id;
    })();

  app.post('/menus', async (req) => {
    const id = saveMenu(null, schemas.menu.parse(req.body));
    changed();
    return { id };
  });
  app.put('/menus/:id', async (req) => {
    saveMenu(idParam.parse(req.params).id, schemas.menu.parse(req.body));
    changed();
    return { ok: true };
  });
  app.delete('/menus/:id', async (req) => {
    db.prepare('DELETE FROM menus WHERE id = ?').run(idParam.parse(req.params).id);
    changed();
    return { ok: true };
  });

  // ---- Operatori ----

  app.get('/operators', async () =>
    all('SELECT id, name, role, active FROM operators ORDER BY name').map((r) => ({ ...r, active: !!r.active })),
  );
  app.post('/operators', async (req) => {
    const v = schemas.operator.parse(req.body);
    if (!v.pin) throw new DomainError(400, 'Indicare il PIN');
    const id = db
      .prepare('INSERT INTO operators (name, role, active, pin_hash) VALUES (?, ?, ?, ?)')
      .run(v.name, v.role, b(v.active), hashPin(v.pin)).lastInsertRowid;
    return { id: Number(id) };
  });
  app.put('/operators/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const v = schemas.operator.parse(req.body);
    const admins = db.prepare("SELECT COUNT(*) AS n FROM operators WHERE role = 'admin' AND active = 1 AND id <> ?").get(id) as {
      n: number;
    };
    if (admins.n === 0 && (v.role !== 'admin' || !v.active)) {
      throw new DomainError(400, 'Deve restare almeno un amministratore attivo');
    }
    db.prepare('UPDATE operators SET name = ?, role = ?, active = ? WHERE id = ?').run(v.name, v.role, b(v.active), id);
    if (v.pin) db.prepare('UPDATE operators SET pin_hash = ? WHERE id = ?').run(hashPin(v.pin), id);
    if (!v.active) db.prepare('DELETE FROM sessions WHERE operator_id = ?').run(id);
    return { ok: true };
  });

  // ---- Impostazioni, stampanti, backup, importazione ----

  app.get('/settings', async () => getSettings(db));
  app.put('/settings', async (req) => {
    saveSettings(db, z.record(z.unknown()).parse(req.body) as never);
    changed();
    return getSettings(db);
  });

  app.post('/printers/:id/test', async (req) => {
    const r = db.prepare('SELECT * FROM printers WHERE id = ?').get(idParam.parse(req.params).id) as
      | Record<string, any>
      | undefined;
    if (!r) throw new DomainError(404, 'Stampante inesistente');
    const printer = mapPrinter(r);
    try {
      await send(printer, testDoc(printer.name), path.join(ctx.dataDir, 'anteprime-stampa'), `test-${Date.now()}`);
    } catch (e) {
      throw new DomainError(502, e instanceof Error ? e.message : String(e));
    }
    return { ok: true };
  });

  app.get('/backup', async (_req, reply) => {
    const file = await backupDb(db, path.join(ctx.dataDir, 'backup'), 'manuale');
    reply.header('content-disposition', `attachment; filename="${path.basename(file)}"`);
    reply.type('application/vnd.sqlite3');
    return reply.send(fs.createReadStream(file));
  });

  app.post('/import-legacy', { bodyLimit: 20 * 1024 * 1024 }, async (req) => {
    const { text, replace } = z.object({ text: z.string().min(1), replace: z.boolean() }).parse(req.body);
    await backupDb(db, path.join(ctx.dataDir, 'backup'), 'pre-import');
    const summary = importLegacy(db, parseLegacyExport(text), { replace });
    changed();
    return summary;
  });
};
