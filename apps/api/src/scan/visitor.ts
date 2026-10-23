// The anonymous scan visitor: an opaque cookie of 32 random bytes. Only its
// SHA-256 is stored, so a database read cannot be turned into a session.
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PgScanStore } from '@feedbouncer/scan';
import { notFound } from '../http/errors.js';

export const VISITOR_COOKIE = 'fb_scan_visitor';
const MAX_AGE_SEC = 30 * 86_400;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const attributes = (maxAge: number, secure: boolean) =>
  `Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;

export function visitorCookieHeader(token: string, secure: boolean): string {
  return `${VISITOR_COOKIE}=${token}; ${attributes(MAX_AGE_SEC, secure)}`;
}

export function clearVisitorCookieHeader(secure: boolean): string {
  return `${VISITOR_COOKIE}=; ${attributes(0, secure)}`;
}

/** The first cookie named exactly VISITOR_COOKIE, if its value is well formed. */
export function readVisitorToken(cookieHeader: string | undefined): string | null {
  for (const part of (cookieHeader ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== VISITOR_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return TOKEN.test(value) ? value : null;
  }
  return null;
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest();

/** The visitor id behind the request's cookie, or null when there is none or it is unknown. */
export async function findVisitor(
  store: PgScanStore,
  req: FastifyRequest,
  now: Date,
): Promise<string | null> {
  const token = readVisitorToken(req.headers.cookie);
  return token === null ? null : store.touchVisitor(tokenHash(token), now);
}

/** Like findVisitor, but a missing visitor is a 404, the same as any id it does not own. */
export async function requireVisitor(
  store: PgScanStore,
  req: FastifyRequest,
  now: Date,
): Promise<string> {
  const id = await findVisitor(store, req, now);
  if (id === null) throw notFound();
  return id;
}

/** The request's visitor, or a new one whose cookie is set on the reply. */
export async function ensureVisitor(
  store: PgScanStore,
  req: FastifyRequest,
  reply: FastifyReply,
  secure: boolean,
  now: Date,
): Promise<string> {
  const known = await findVisitor(store, req, now);
  if (known !== null) return known;
  const token = randomBytes(32).toString('base64url');
  const id = await store.createVisitor(tokenHash(token));
  void reply.header('set-cookie', visitorCookieHeader(token, secure));
  return id;
}
