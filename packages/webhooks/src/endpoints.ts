import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { recordAuditEvent, withTransaction } from '@feedbouncer/db';
import type { ApiKeyContext, WebhookEndpointOut, WebhookEventType } from '@feedbouncer/public-api';
import { open, seal, type KeyProvider } from '@feedbouncer/secrets';
import type { Secret } from '@feedbouncer/service-runtime';
import { MAX_ENDPOINTS_PER_ORG, ROTATION_OVERLAP_SECONDS } from './constants.js';
import { validateWebhookUrl, type UrlRejection } from './destination.js';
import { generateSigningSecret } from './signing.js';

export type { WebhookEndpointOut };

export class InvalidWebhookUrlError extends Error {
  constructor(readonly reason: UrlRejection) {
    super(`Webhook URL rejected: ${reason}`);
    this.name = 'InvalidWebhookUrlError';
  }
}

export class EndpointLimitError extends Error {
  constructor() {
    super(`An organization can have at most ${MAX_ENDPOINTS_PER_ORG} webhook endpoints`);
    this.name = 'EndpointLimitError';
  }
}

export interface EndpointUpdate {
  url?: string | undefined;
  description?: string | null | undefined;
  eventTypes?: WebhookEventType[] | undefined;
  status?: 'active' | 'disabled' | undefined;
}

interface Row {
  id: string;
  url: string;
  description: string | null;
  event_types: WebhookEventType[];
  status: 'active' | 'disabled';
  disabled_reason: 'consecutive_failures' | 'manual' | null;
  disabled_at: Date | null;
  rotation_overlap_until: Date | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, url, description, event_types, status, disabled_reason, disabled_at,
  rotation_overlap_until, created_at, updated_at`;

const iso = (d: Date | null) => d?.toISOString() ?? null;

const toOut = (r: Row): WebhookEndpointOut => ({
  id: r.id,
  url: r.url,
  description: r.description,
  eventTypes: r.event_types,
  status: r.status,
  disabledReason: r.disabled_reason,
  disabledAt: iso(r.disabled_at),
  rotationOverlapUntil: iso(r.rotation_overlap_until),
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

const secretContext = (organizationId: string, endpointId: string) =>
  ({ organizationId, connectionId: endpointId, kind: 'webhook_endpoint_secret' }) as const;

export class PgWebhookEndpoints {
  constructor(
    private readonly pool: pg.Pool,
    private readonly keys: KeyProvider,
    private readonly opts: {
      resolve(host: string): Promise<string[]>;
      allowedPrivateCidrs: readonly string[];
    },
  ) {}

  async #checkUrl(url: string): Promise<string> {
    const checked = await validateWebhookUrl(url, this.opts);
    if (!checked.ok) throw new InvalidWebhookUrlError(checked.reason);
    return checked.url.href;
  }

  async create(
    ctx: ApiKeyContext,
    i: { url: string; description?: string | undefined; eventTypes: WebhookEventType[] },
  ): Promise<{ endpoint: WebhookEndpointOut; secret: Secret }> {
    const url = await this.#checkUrl(i.url);
    const id = randomUUID();
    const secret = generateSigningSecret();
    const sealed = await seal(this.keys, secret, secretContext(ctx.organizationId, id));
    const endpoint = await withTransaction(this.pool, async (tx) => {
      await tx.query('SELECT 1 FROM organization WHERE id = $1 FOR UPDATE', [ctx.organizationId]);
      const count = await tx.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM webhook_endpoint WHERE organization_id = $1',
        [ctx.organizationId],
      );
      if (count.rows[0]!.n >= MAX_ENDPOINTS_PER_ORG) throw new EndpointLimitError();
      const { rows } = await tx.query<Row>(
        `INSERT INTO webhook_endpoint
           (id, organization_id, url, description, event_types, signing_key_id,
            encrypted_signing_secret, created_by_api_key_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLUMNS}`,
        [
          id,
          ctx.organizationId,
          url,
          i.description ?? null,
          i.eventTypes,
          sealed.keyId,
          sealed.blob,
          ctx.apiKeyId,
        ],
      );
      await this.#audit(tx, ctx, 'created', id);
      return toOut(rows[0]!);
    });
    return { endpoint, secret };
  }

  async list(org: string): Promise<WebhookEndpointOut[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM webhook_endpoint WHERE organization_id = $1 ORDER BY created_at, id`,
      [org],
    );
    return rows.map(toOut);
  }

  async get(org: string, id: string): Promise<WebhookEndpointOut | null> {
    const { rows } = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM webhook_endpoint WHERE organization_id = $1 AND id = $2`,
      [org, id],
    );
    return rows[0] ? toOut(rows[0]) : null;
  }

  async update(
    ctx: ApiKeyContext,
    id: string,
    p: EndpointUpdate,
  ): Promise<WebhookEndpointOut | null> {
    const url = p.url === undefined ? undefined : await this.#checkUrl(p.url);
    return withTransaction(this.pool, async (tx) => {
      const current = await tx.query<Row>(
        `SELECT ${COLUMNS} FROM webhook_endpoint WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
        [ctx.organizationId, id],
      );
      if (!current.rows[0]) return null;
      const was = current.rows[0].status;
      const enabling = p.status === 'active' && was === 'disabled';
      const disabling = p.status === 'disabled' && was === 'active';

      const sets: string[] = [];
      const params: unknown[] = [ctx.organizationId, id];
      const changed: string[] = [];
      const set = (field: string, column: string, value: unknown) => {
        sets.push(`${column} = $${params.push(value)}`);
        changed.push(field);
      };
      if (url !== undefined) set('url', 'url', url);
      if (p.description !== undefined) set('description', 'description', p.description);
      if (p.eventTypes) set('eventTypes', 'event_types', p.eventTypes);
      if (disabling) {
        sets.push(`status = 'disabled'`, `disabled_reason = 'manual'`, 'disabled_at = now()');
        changed.push('status');
      }
      if (enabling) {
        sets.push(
          `status = 'active'`,
          'disabled_reason = NULL',
          'disabled_at = NULL',
          'consecutive_failures = 0',
          'first_failure_at = NULL',
        );
      }
      if (sets.length === 0) return toOut(current.rows[0]);

      const { rows } = await tx.query<Row>(
        `UPDATE webhook_endpoint SET ${sets.join(', ')}
          WHERE organization_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
        params,
      );
      if (changed.length > 0)
        await this.#audit(tx, ctx, 'updated', id, { fields: changed.join(',') });
      if (enabling) await this.#audit(tx, ctx, 'enabled', id);
      return toOut(rows[0]!);
    });
  }

  async remove(ctx: ApiKeyContext, id: string): Promise<boolean> {
    return withTransaction(this.pool, async (tx) => {
      const r = await tx.query(
        'DELETE FROM webhook_endpoint WHERE organization_id = $1 AND id = $2',
        [ctx.organizationId, id],
      );
      if (r.rowCount === 0) return false;
      await this.#audit(tx, ctx, 'deleted', id);
      return true;
    });
  }

  async rotateSecret(
    ctx: ApiKeyContext,
    id: string,
  ): Promise<{ secret: Secret; previousSecretExpiresAt: string } | null> {
    const secret = generateSigningSecret();
    const sealed = await seal(this.keys, secret, secretContext(ctx.organizationId, id));
    return withTransaction(this.pool, async (tx) => {
      const { rows } = await tx.query<{ rotation_overlap_until: Date }>(
        `UPDATE webhook_endpoint
            SET previous_signing_key_id = signing_key_id,
                encrypted_previous_signing_secret = encrypted_signing_secret,
                signing_key_id = $3, encrypted_signing_secret = $4,
                rotation_overlap_until = now() + make_interval(secs => $5)
          WHERE organization_id = $1 AND id = $2 RETURNING rotation_overlap_until`,
        [ctx.organizationId, id, sealed.keyId, sealed.blob, ROTATION_OVERLAP_SECONDS],
      );
      if (!rows[0]) return null;
      await this.#audit(tx, ctx, 'secret_rotated', id);
      return { secret, previousSecretExpiresAt: rows[0].rotation_overlap_until.toISOString() };
    });
  }

  /** The current secret first, then the previous one while its overlap lasts. */
  async signingSecrets(c: pg.ClientBase, org: string, id: string, now: Date): Promise<Secret[]> {
    const { rows } = await c.query<{
      encrypted_signing_secret: Buffer;
      encrypted_previous_signing_secret: Buffer | null;
      rotation_overlap_until: Date | null;
    }>(
      `SELECT encrypted_signing_secret, encrypted_previous_signing_secret, rotation_overlap_until
         FROM webhook_endpoint WHERE organization_id = $1 AND id = $2`,
      [org, id],
    );
    const row = rows[0];
    if (!row) return [];
    const ctx = secretContext(org, id);
    const secrets = [await open(this.keys, row.encrypted_signing_secret, ctx)];
    if (row.encrypted_previous_signing_secret && row.rotation_overlap_until! > now)
      secrets.push(await open(this.keys, row.encrypted_previous_signing_secret, ctx));
    return secrets;
  }

  #audit(
    tx: pg.ClientBase,
    ctx: ApiKeyContext,
    action: 'created' | 'updated' | 'deleted' | 'secret_rotated' | 'enabled',
    id: string,
    details: Record<string, string> = {},
  ) {
    return recordAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorType: 'api_key',
      action: `webhook_endpoint.${action}`,
      subjectType: 'webhook_endpoint',
      subjectId: id,
      details: { apiKeyId: ctx.apiKeyId, ...details },
    });
  }
}
