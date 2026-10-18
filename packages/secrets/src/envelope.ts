// Envelope v1: a fresh AES-256-GCM data key per seal encrypts the credential;
// the deployment key (KeyProvider) wraps that data key. Both layers bind the
// record identity as AAD, so a blob copied to another row or tenant fails.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Secret } from '@feedbouncer/service-runtime';
import { CredentialUnreadableError } from './errors.js';
import { KEY_ID_PATTERN } from './key-id.js';
import type { KeyProvider } from './key-provider.js';

export const ENVELOPE_VERSION = 0x01;
export const MAX_PLAINTEXT_BYTES = 16_384;
const IV = 12;
const TAG = 16;
const DEK = 32;

export const CREDENTIAL_KINDS = ['access_token', 'refresh_token', 'webhook_secret'] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

// Envelope-only kinds are sealed outside connection_secret (e.g. oauth_state).
// connectionId in EnvelopeContext is the bound record id for those kinds.
export const ENVELOPE_KINDS = [
  ...CREDENTIAL_KINDS,
  'oauth_pkce_verifier',
  'oauth_grant_token',
  'alert_slack_webhook',
  'alert_unsubscribe_token',
  'report_unsubscribe_token',
  'webhook_endpoint_secret',
] as const;
export type EnvelopeKind = (typeof ENVELOPE_KINDS)[number];

export interface EnvelopeContext {
  readonly organizationId: string;
  readonly connectionId: string;
  readonly kind: EnvelopeKind;
}

interface ParsedEnvelope {
  keyId: string;
  wrapped: Buffer;
  iv: Buffer;
  tag: Buffer;
  ct: Buffer;
}

// The AAD joins the identity fields with NUL, so a NUL inside a field could make
// two different records produce the same AAD. Reject it (and unknown kinds).
function assertContext(c: EnvelopeContext): void {
  if (
    typeof c.organizationId !== 'string' ||
    typeof c.connectionId !== 'string' ||
    c.organizationId.includes('\0') ||
    c.connectionId.includes('\0')
  ) {
    throw new TypeError('Envelope context ids must be strings without NUL characters.');
  }
  if (!(ENVELOPE_KINDS as readonly string[]).includes(c.kind)) {
    throw new TypeError('Envelope context has an unknown envelope kind.');
  }
}

function checkWrapped(w: { keyId: string; wrapped: Buffer }, activeKeyId: string): void {
  if (w.keyId !== activeKeyId) {
    throw new Error('KeyProvider wrapped with a key other than its active key');
  }
  if (w.wrapped.length < 1 || w.wrapped.length > 0xffff) {
    throw new Error('KeyProvider returned a wrapped key of unsupported length');
  }
}

function checkDek(dek: Buffer, keyId: string): void {
  if (dek.length !== DEK) throw new CredentialUnreadableError('malformed', keyId);
}

const identity = (c: EnvelopeContext) => `${c.organizationId}\0${c.connectionId}\0${c.kind}`;
const dataAad = (c: EnvelopeContext) => Buffer.from(`fb-credential:v1\0${identity(c)}`, 'utf8');
const wrapAad = (keyId: string, c: EnvelopeContext) =>
  Buffer.from(`fb-dek:v1\0${keyId}\0${identity(c)}`, 'utf8');

export function parseEnvelope(blob: Buffer): ParsedEnvelope {
  const malformed = (keyId: string | null = null) =>
    new CredentialUnreadableError('malformed', keyId);
  if (blob.length < 2 || blob[0] !== ENVELOPE_VERSION) throw malformed();
  const idLen = blob[1]!;
  let off = 2;
  if (idLen < 1 || idLen > 32 || blob.length < off + idLen + 2) throw malformed();
  const keyId = blob.subarray(off, off + idLen).toString('latin1');
  off += idLen;
  if (!KEY_ID_PATTERN.test(keyId)) throw malformed();
  const wLen = blob.readUInt16BE(off);
  off += 2;
  if (wLen < 1 || blob.length < off + wLen + IV + TAG + 1) throw malformed(keyId);
  const wrapped = blob.subarray(off, off + wLen);
  off += wLen;
  const iv = blob.subarray(off, off + IV);
  off += IV;
  const tag = blob.subarray(off, off + TAG);
  off += TAG;
  const ct = blob.subarray(off);
  if (ct.length > MAX_PLAINTEXT_BYTES) throw malformed(keyId);
  return { keyId, wrapped, iv, tag, ct };
}

function assemble(keyId: string, wrapped: Buffer, iv: Buffer, tag: Buffer, ct: Buffer): Buffer {
  const id = Buffer.from(keyId, 'latin1');
  const wLen = Buffer.alloc(2);
  wLen.writeUInt16BE(wrapped.length);
  return Buffer.concat([
    Buffer.from([ENVELOPE_VERSION, id.length]),
    id,
    wLen,
    wrapped,
    iv,
    tag,
    ct,
  ]);
}

function decryptData(dek: Buffer, p: ParsedEnvelope, ctx: EnvelopeContext): Buffer {
  const d = createDecipheriv('aes-256-gcm', dek, p.iv, { authTagLength: TAG });
  d.setAAD(dataAad(ctx));
  d.setAuthTag(p.tag);
  let head: Buffer | undefined;
  try {
    head = d.update(p.ct);
    return Buffer.concat([head, d.final()]);
  } catch {
    throw new CredentialUnreadableError('tampered', p.keyId);
  } finally {
    head?.fill(0);
  }
}

export async function seal(
  keys: KeyProvider,
  value: Secret,
  ctx: EnvelopeContext,
): Promise<{ keyId: string; blob: Buffer }> {
  assertContext(ctx);
  const plain = Buffer.from(value.reveal(), 'utf8');
  const dek = randomBytes(DEK);
  try {
    if (plain.length > MAX_PLAINTEXT_BYTES) {
      throw new RangeError(`Credential is longer than ${MAX_PLAINTEXT_BYTES} bytes.`);
    }
    const iv = randomBytes(IV);
    const c = createCipheriv('aes-256-gcm', dek, iv, { authTagLength: TAG });
    c.setAAD(dataAad(ctx));
    const ct = Buffer.concat([c.update(plain), c.final()]);
    const tag = c.getAuthTag();
    const keyId = keys.activeKeyId;
    const w = await keys.wrap(dek, wrapAad(keyId, ctx));
    checkWrapped(w, keyId);
    return { keyId, blob: assemble(keyId, w.wrapped, iv, tag, ct) };
  } finally {
    dek.fill(0);
    plain.fill(0);
  }
}

export async function open(keys: KeyProvider, blob: Buffer, ctx: EnvelopeContext): Promise<Secret> {
  assertContext(ctx);
  const p = parseEnvelope(blob);
  const dek = await keys.unwrap(p.keyId, p.wrapped, wrapAad(p.keyId, ctx));
  try {
    checkDek(dek, p.keyId);
    const plain = decryptData(dek, p, ctx);
    try {
      return new Secret(plain.toString('utf8'));
    } finally {
      plain.fill(0);
    }
  } finally {
    dek.fill(0);
  }
}

/** Re-wraps the data key under the active key. The data part is verified first, then reused unchanged. */
export async function rewrap(
  keys: KeyProvider,
  blob: Buffer,
  ctx: EnvelopeContext,
): Promise<{ keyId: string; blob: Buffer; changed: boolean }> {
  assertContext(ctx);
  const p = parseEnvelope(blob);
  if (p.keyId === keys.activeKeyId) return { keyId: p.keyId, blob, changed: false };
  const dek = await keys.unwrap(p.keyId, p.wrapped, wrapAad(p.keyId, ctx));
  try {
    checkDek(dek, p.keyId);
    decryptData(dek, p, ctx).fill(0); // never launder a tampered record onto the new key
    const keyId = keys.activeKeyId;
    const w = await keys.wrap(dek, wrapAad(keyId, ctx));
    checkWrapped(w, keyId);
    return { keyId, blob: assemble(keyId, w.wrapped, p.iv, p.tag, p.ct), changed: true };
  } finally {
    dek.fill(0);
  }
}
