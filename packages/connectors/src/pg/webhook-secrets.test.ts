import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { CredentialUnreadableError, type CredentialStore } from '@feedbouncer/secrets';
import { Secret } from '@feedbouncer/service-runtime';
import { PgWebhookSecrets } from './webhook-secrets.js';

const ID = '7f0c2a52-3c1e-4c55-9d2a-0b6f1b0c9e11';
const pool = {
  query: async () => ({
    rows: [{ organization_id: 'o1', brand_id: 'b1', external_account_id: 'page-1' }],
  }),
} as unknown as pg.Pool;
const secretsWith = (get: () => Promise<unknown>) =>
  new PgWebhookSecrets(pool, { get } as unknown as CredentialStore, new Map());

describe('PgWebhookSecrets.connectionSecret', () => {
  it('returns the stored secret and bound account', async () => {
    const s = secretsWith(async () => ({ value: new Secret('whsec') }));
    const hit = await s.connectionSecret(ID, 'facebook');
    expect(hit?.externalAccountId).toBe('page-1');
    expect(hit?.secret.reveal()).toBe('whsec');
  });

  it('treats an unreadable credential as no secret', async () => {
    const s = secretsWith(async () => {
      throw new CredentialUnreadableError('tampered', 'k1');
    });
    expect(await s.connectionSecret(ID, 'facebook')).toBeNull();
  });

  it('rethrows any other failure instead of hiding it', async () => {
    const outage = new Error('connection terminated');
    const s = secretsWith(async () => {
      throw outage;
    });
    await expect(s.connectionSecret(ID, 'facebook')).rejects.toBe(outage);
  });
});
