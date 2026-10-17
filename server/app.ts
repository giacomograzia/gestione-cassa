import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import type { WebSocket } from 'ws';
import type { RealtimeEvent } from '../shared/types.js';
import { operatorFromToken, SESSION_COOKIE } from './auth.js';
import type { DB } from './db.js';
import { DomainError } from './domain/orders.js';
import { PrintQueue } from './print/queue.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { salesRoutes } from './routes/sales.js';

export interface AppContext {
  db: DB;
  dataDir: string;
  queue: PrintQueue;
  broadcast: (e: RealtimeEvent) => void;
}

export async function buildApp(opts: { db: DB; dataDir: string; webDir?: string; logger?: boolean }) {
  const app = Fastify({ logger: opts.logger ? { level: 'info' } : false, disableRequestLogging: true });
  const sockets = new Set<WebSocket>();
  const broadcast = (e: RealtimeEvent) => {
    const msg = JSON.stringify(e);
    for (const s of sockets) if (s.readyState === s.OPEN) s.send(msg);
  };
  const queue = new PrintQueue(opts.db, path.join(opts.dataDir, 'anteprime-stampa'), (jobId, printer, error) =>
    broadcast({ type: 'print-failed', jobId, printer, error }),
  );
  const ctx: AppContext = { db: opts.db, dataDir: opts.dataDir, queue, broadcast };

  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket);

  app.decorateRequest('operator', null);
  app.addHook('onRequest', async (req) => {
    req.operator = operatorFromToken(opts.db, req.cookies[SESSION_COOKIE]);
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DomainError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return reply.code(400).send({ error: `Dati non validi: ${first.path.join('.')} ${first.message}` });
    }
    const sqliteCode = (err as { code?: string }).code;
    if (sqliteCode === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
      return reply.code(409).send({ error: 'Elemento in uso: non può essere eliminato' });
    }
    if (sqliteCode?.startsWith('SQLITE_CONSTRAINT')) {
      return reply.code(409).send({ error: 'Dati in conflitto con quelli esistenti' });
    }
    app.log.error(err);
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode && e.statusCode < 500 ? e.statusCode : 500;
    return reply.code(status).send({ error: status === 500 ? 'Errore interno del server' : e.message });
  });

  app.get('/ws', { websocket: true }, (socket, req) => {
    if (!req.operator) {
      socket.close(4401, 'Accesso richiesto');
      return;
    }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await app.register(authRoutes(ctx), { prefix: '/api' });
  await app.register(salesRoutes(ctx), { prefix: '/api' });
  await app.register(adminRoutes(ctx), { prefix: '/api/admin' });

  if (opts.webDir && fs.existsSync(opts.webDir)) {
    await app.register(fastifyStatic, { root: opts.webDir });
    // l'interfaccia è una single-page app: ogni percorso non-API serve index.html
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Non trovato' });
      return reply.sendFile('index.html');
    });
  }

  return { app: app as FastifyInstance, ctx };
}
