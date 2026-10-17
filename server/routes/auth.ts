import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { createSession, hashPin, LoginLimiter, SESSION_COOKIE, verifyPin } from '../auth.js';

const pin = z.string().regex(/^\d{4,8}$/, 'il PIN deve avere da 4 a 8 cifre');

export const authRoutes = (ctx: AppContext): FastifyPluginAsync => async (app) => {
  const { db } = ctx;
  const limiter = new LoginLimiter();
  const cookieOpts = { path: '/', httpOnly: true, sameSite: 'strict' as const, maxAge: 60 * 60 * 24 * 30 };

  const needsSetup = () => (db.prepare('SELECT COUNT(*) AS n FROM operators').get() as { n: number }).n === 0;

  app.get('/setup', async () => ({ needsSetup: needsSetup() }));

  /** Primo avvio: crea l'amministratore. Disponibile solo finché non esiste alcun operatore. */
  app.post('/setup', async (req, reply) => {
    const body = z.object({ name: z.string().trim().min(1).max(40), pin }).parse(req.body);
    if (!needsSetup()) return reply.code(409).send({ error: 'Configurazione già eseguita' });
    const id = Number(
      db.prepare("INSERT INTO operators (name, pin_hash, role) VALUES (?, ?, 'admin')").run(body.name, hashPin(body.pin))
        .lastInsertRowid,
    );
    reply.setCookie(SESSION_COOKIE, createSession(db, id), cookieOpts);
    return { ok: true };
  });

  app.get('/auth/operators', async () =>
    db.prepare('SELECT id, name, role FROM operators WHERE active = 1 ORDER BY name').all(),
  );

  app.post('/auth/login', async (req, reply) => {
    const body = z.object({ operatorId: z.number().int(), pin: z.string() }).parse(req.body);
    if (!limiter.check(req.ip)) {
      return reply.code(429).send({ error: 'Troppi tentativi: riprova tra un minuto' });
    }
    const op = db.prepare('SELECT id, pin_hash FROM operators WHERE id = ? AND active = 1').get(body.operatorId) as
      | { id: number; pin_hash: string }
      | undefined;
    if (!op || !verifyPin(body.pin, op.pin_hash)) {
      limiter.fail(req.ip);
      return reply.code(401).send({ error: 'PIN errato' });
    }
    limiter.reset(req.ip);
    reply.setCookie(SESSION_COOKIE, createSession(db, op.id), cookieOpts);
    return { ok: true };
  });

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/auth/me', async (req, reply) => {
    if (!req.operator) return reply.code(401).send({ error: 'Accesso richiesto' });
    return req.operator;
  });
};
