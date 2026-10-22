import { createHash, randomBytes } from 'node:crypto';
import { Secret } from '@feedbouncer/service-runtime';

export const API_KEY_SCOPES = ['moderate', 'read', 'write'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const KEY_RE = /^fbk_([a-z2-7]{16})_([A-Za-z0-9_-]{43})$/;

const sha256 = (secret: string): Buffer => createHash('sha256').update(secret).digest();

function base32(bytes: Buffer): string {
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

export function generateApiKey(): { publicId: string; token: Secret; secretSha256: Buffer } {
  const publicId = base32(randomBytes(10));
  const secret = randomBytes(32).toString('base64url');
  return { publicId, token: new Secret(`fbk_${publicId}_${secret}`), secretSha256: sha256(secret) };
}

export function parseApiKey(raw: string): { publicId: string; secretSha256: Buffer } | null {
  const m = KEY_RE.exec(raw);
  return m ? { publicId: m[1]!, secretSha256: sha256(m[2]!) } : null;
}

const RANK: Record<ApiKeyScope, number> = { moderate: 0, read: 1, write: 2 };

export function scopeAllows(have: ApiKeyScope, need: ApiKeyScope): boolean {
  return RANK[have] >= RANK[need];
}
