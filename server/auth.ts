import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from './db.js';
import type { Operator, Role } from '../shared/types.js';

export const SESSION_COOKIE = 'cassa_session';

export function hashPin(pin: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pin, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(pin, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export function createSession(db: DB, operatorId: number): string {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token, operator_id) VALUES (?, ?)').run(token, operatorId);
  return token;
}

export function operatorFromToken(db: DB, token: string | undefined): Operator | null {
  if (!token) return null;
  const r = db
    .prepare(
      `SELECT o.id, o.name, o.role, o.active FROM sessions s JOIN operators o ON o.id = s.operator_id
       WHERE s.token = ? AND o.active = 1`,
    )
    .get(token) as { id: number; name: string; role: Role; active: number } | undefined;
  return r ? { id: r.id, name: r.name, role: r.role, active: !!r.active } : null;
}

declare module 'fastify' {
  interface FastifyRequest {
    operator: Operator | null;
  }
}

/** Restituisce un preHandler che ammette solo i ruoli indicati (admin è sempre ammesso). */
export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.operator) return reply.code(401).send({ error: 'Accesso richiesto' });
    if (req.operator.role !== 'admin' && !roles.includes(req.operator.role)) {
      return reply.code(403).send({ error: 'Operazione non consentita per il tuo ruolo' });
    }
  };
}

/** Limita i tentativi di PIN errati per indirizzo IP. */
export class LoginLimiter {
  private failures = new Map<string, { count: number; until: number }>();
  check(ip: string): boolean {
    const f = this.failures.get(ip);
    return !f || f.until < Date.now() || f.count < 5;
  }
  fail(ip: string) {
    const f = this.failures.get(ip);
    const count = f && f.until > Date.now() ? f.count + 1 : 1;
    this.failures.set(ip, { count, until: Date.now() + 60_000 });
  }
  reset(ip: string) {
    this.failures.delete(ip);
  }
}
