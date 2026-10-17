import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { requireRole } from '../auth.js';
import { backupDb } from '../db.js';
import { createOrder, voidOrder } from '../domain/orders.js';
import { closeDay, computeStats, statsToCsv } from '../domain/stats.js';
import { printOrder, printVoidNotices } from '../print/printOrder.js';
import { getCatalog, getOrder, getSettings, listOrders, mapTill } from '../repo.js';
import type { Closure } from '../../shared/types.js';
import path from 'node:path';

const note = z.string().max(200).optional();
const productLine = z.object({
  productId: z.number().int(),
  qty: z.number().int().min(1).max(999),
  gift: z.boolean().optional(),
  note,
  priceCents: z.number().int().min(0).max(1_000_000).optional(),
});
const menuLine = z.object({
  menuId: z.number().int(),
  qty: z.number().int().min(1).max(999),
  gift: z.boolean().optional(),
  note,
  components: z.array(z.object({ componentId: z.number().int(), productIds: z.array(z.number().int()) })),
});
const newOrder = z.object({
  tillId: z.number().int(),
  tableLabel: z.string().max(40).optional(),
  takeaway: z.boolean().optional(),
  note,
  lines: z.array(z.union([menuLine, productLine])).min(1).max(200),
  discount: z.object({ type: z.enum(['percent', 'amount']), value: z.number().min(0) }).optional(),
  payment: z.object({ method: z.enum(['contanti', 'carta', 'altro']), paidCents: z.number().int().min(0) }),
});
const idParam = z.object({ id: z.coerce.number().int() });

export const salesRoutes = (ctx: AppContext): FastifyPluginAsync => async (app) => {
  const { db, queue, broadcast } = ctx;
  const anyRole = requireRole('cassa', 'cucina');
  const cassa = requireRole('cassa');

  app.get('/catalog', { preHandler: anyRole }, async () => getCatalog(db));
  app.get('/settings', { preHandler: anyRole }, async () => getSettings(db));
  app.get('/tills', { preHandler: anyRole }, async () =>
    (db.prepare('SELECT * FROM tills ORDER BY name').all() as Record<string, any>[]).map(mapTill),
  );

  // ---- Ordini ----

  app.post('/orders', { preHandler: cassa }, async (req) => {
    const input = newOrder.parse(req.body);
    const id = createOrder(db, input, req.operator!.id);
    printOrder(db, queue, id);
    broadcast({ type: 'order', orderId: id });
    broadcast({ type: 'stock' });
    broadcast({ type: 'kitchen' });
    return getOrder(db, id);
  });

  app.get('/orders', { preHandler: cassa }, async (req) => {
    const q = z
      .object({ closure: z.union([z.literal('open'), z.coerce.number().int()]).default('open') })
      .parse(req.query);
    return listOrders(db, { closureId: q.closure === 'open' ? null : q.closure });
  });

  app.get('/orders/:id', { preHandler: cassa }, async (req, reply) => {
    const o = getOrder(db, idParam.parse(req.params).id);
    return o ?? reply.code(404).send({ error: 'Ordine inesistente' });
  });

  app.post('/orders/:id/void', { preHandler: cassa }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { reason } = z.object({ reason: z.string().max(200) }).parse(req.body);
    const stations = voidOrder(db, id, req.operator!.id, reason);
    printVoidNotices(db, queue, id, stations);
    broadcast({ type: 'order', orderId: id });
    broadcast({ type: 'stock' });
    broadcast({ type: 'kitchen' });
    return getOrder(db, id);
  });

  app.post('/orders/:id/reprint', { preHandler: cassa }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { what } = z.object({ what: z.enum(['all', 'receipt', 'comande']) }).parse(req.body);
    printOrder(db, queue, id, what);
    return { ok: true };
  });

  // ---- Cucina ----

  app.get('/kitchen', { preHandler: anyRole }, async (req) => {
    const { station, done } = z
      .object({ station: z.coerce.number().int(), done: z.string().optional().transform((v) => v === '1' || v === 'true') })
      .parse(req.query);
    // ordini con righe da preparare (o pronte, se richieste) per questo reparto
    const status = done ? "('ready')" : "('pending', 'ready')";
    const ids = (
      db
        .prepare(
          `SELECT DISTINCT l.order_id FROM order_lines l JOIN orders o ON o.id = l.order_id
           WHERE l.station_id = ? AND l.kitchen_status IN ${status} AND o.status = 'ok'
           ORDER BY l.order_id LIMIT 200`,
        )
        .all(station) as { order_id: number }[]
    ).map((r) => r.order_id);
    return listOrders(db, { ids }).reverse();
  });

  app.post('/kitchen/lines/:id', { preHandler: anyRole }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { status } = z.object({ status: z.enum(['pending', 'ready', 'delivered']) }).parse(req.body);
    db.prepare(
      `UPDATE order_lines SET kitchen_status = ?, ready_at = CASE WHEN ? = 'pending' THEN NULL ELSE datetime('now', 'localtime') END
       WHERE id = ? AND kitchen_status <> 'none'`,
    ).run(status, status, id);
    broadcast({ type: 'kitchen' });
    return { ok: true };
  });

  /** Cambia lo stato di tutte le righe di un ordine per un reparto. */
  app.post('/kitchen/orders/:id', { preHandler: anyRole }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({ station: z.number().int(), status: z.enum(['pending', 'ready', 'delivered']) })
      .parse(req.body);
    db.prepare(
      `UPDATE order_lines SET kitchen_status = ?, ready_at = CASE WHEN ? = 'pending' THEN NULL ELSE datetime('now', 'localtime') END
       WHERE order_id = ? AND station_id = ? AND kitchen_status <> 'none'`,
    ).run(body.status, body.status, id, body.station);
    broadcast({ type: 'kitchen' });
    return { ok: true };
  });

  // ---- Statistiche e chiusure ----

  const scopeQuery = z.object({ closure: z.union([z.enum(['open', 'all']), z.coerce.number().int()]).default('open') });
  const scopeOf = (c: 'open' | 'all' | number) => (c === 'all' ? ('all' as const) : { closureId: c === 'open' ? null : c });

  app.get('/stats', { preHandler: cassa }, async (req) => computeStats(db, scopeOf(scopeQuery.parse(req.query).closure)));

  app.get('/stats.csv', { preHandler: cassa }, async (req, reply) => {
    const { closure } = scopeQuery.parse(req.query);
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="venduto-${closure}.csv"`);
    return statsToCsv(computeStats(db, scopeOf(closure)));
  });

  app.get('/closures', { preHandler: cassa }, async (): Promise<Closure[]> =>
    (
      db
        .prepare(
          `SELECT c.*, o.name AS operator_name FROM closures c LEFT JOIN operators o ON o.id = c.operator_id
           ORDER BY c.id DESC`,
        )
        .all() as Record<string, any>[]
    ).map((r) => ({ id: r.id, createdAt: r.created_at, operatorName: r.operator_name, totals: JSON.parse(r.totals_json) })),
  );

  app.post('/closures', { preHandler: requireRole() }, async (req) => {
    await backupDb(db, path.join(ctx.dataDir, 'backup'), 'pre-chiusura');
    const id = closeDay(db, req.operator!.id);
    broadcast({ type: 'order', orderId: 0 });
    return { id };
  });

  // ---- Stampe ----

  app.get('/print-jobs', { preHandler: cassa }, async () =>
    db
      .prepare(
        `SELECT j.id, j.created_at AS createdAt, j.kind, j.status, j.error, j.order_id AS orderId, p.name AS printer
         FROM print_jobs j LEFT JOIN printers p ON p.id = j.printer_id
         WHERE j.status <> 'done' OR j.created_at > datetime('now', 'localtime', '-1 hour')
         ORDER BY j.id DESC LIMIT 100`,
      )
      .all(),
  );

  app.post('/print-jobs/:id/retry', { preHandler: cassa }, async (req, reply) => {
    const ok = queue.retry(idParam.parse(req.params).id);
    return ok ? { ok } : reply.code(404).send({ error: 'Stampa inesistente' });
  });
};
