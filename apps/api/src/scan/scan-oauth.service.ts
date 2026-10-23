// The free scan's own Facebook Login leg, for anonymous visitors. The state is
// 32 random bytes; only its hash is stored, bound to the visitor, single-use
// and expiring, with the PKCE verifier sealed beside it. The code exchange is
// the only write to Meta: every read after it goes through readOnlyHttp.
// Redirects are fixed /scan paths built from ids and constants, never from
// the query. Codes, tokens and states are never logged.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  ConnectorError,
  STATE_PATTERN,
  createSafeHttp,
  hashState,
  newPkcePair,
  type SafeHttp,
} from '@feedbouncer/connectors';
import {
  buildAuthorizationUrl,
  exchangeCode,
  type FacebookConfig,
} from '@feedbouncer/connector-facebook';
import {
  SCAN_ENVELOPE_ORG,
  SCAN_OPTIONAL_SCOPES,
  SCAN_REQUIRED_SCOPES,
  listScanPages,
  missingScopes,
  readOnlyHttp,
  type PgScanStore,
  type ScanGraph,
} from '@feedbouncer/scan';
import { open, seal } from '@feedbouncer/secrets';
import { Secret } from '@feedbouncer/service-runtime';
import type { AppDeps } from '../deps.js';
import { notFound } from '../http/errors.js';
import { DEPS, SCAN_STORE } from '../tokens.js';

export const SCAN_CALLBACK_PATH = '/api/v1/scan/oauth/meta/callback';
const SCAN_SCOPES = [...SCAN_REQUIRED_SCOPES, ...SCAN_OPTIONAL_SCOPES];
const STATE_TTL_MS = 10 * 60_000;
const GRANT_TTL_MS = 30 * 60_000;
const GRAPH_TIMEOUT_MS = 15_000;

/** The callback's query. Facebook adds other fields (error_code, error_description), which are ignored. */
const CallbackQuery = z.object({
  code: z
    .string()
    .regex(/^[\x21-\x7e]{1,2048}$/)
    .optional(),
  state: z.string().max(64).optional(),
  error: z.string().max(200).optional(),
  error_reason: z.string().max(200).optional(),
});

type CallbackError = 'declined' | 'state_invalid' | 'missing_permissions' | 'platform_unavailable';
const failed = (error: CallbackError | 'internal') => ({ redirectTo: `/scan?error=${error}` });

const pkceCtx = (stateHash: Buffer) => ({
  organizationId: SCAN_ENVELOPE_ORG,
  connectionId: stateHash.toString('hex'),
  kind: 'scan_pkce_verifier' as const,
});
const grantTokenCtx = (grantId: string) => ({
  organizationId: SCAN_ENVELOPE_ORG,
  connectionId: grantId,
  kind: 'scan_user_token' as const,
});

@Injectable()
export class ScanOAuthService {
  /** Unwrapped, for the code exchange only. */
  readonly #http: SafeHttp;
  readonly #redirectUri: string;

  constructor(
    @Inject(DEPS) private readonly deps: AppDeps,
    @Inject(SCAN_STORE) private readonly store: PgScanStore,
  ) {
    this.#http = createSafeHttp({
      allowedHosts: ['graph.facebook.com'],
      ...(deps.scanFetch && { fetch: deps.scanFetch }),
    });
    this.#redirectUri = new URL(SCAN_CALLBACK_PATH, deps.env.publicWebUrl).href;
  }

  #facebook(): FacebookConfig {
    const fb = this.deps.env.facebook;
    if (!fb) throw notFound();
    return fb;
  }

  async start(visitorId: string): Promise<{ authorizeUrl: string }> {
    const fb = this.#facebook();
    const state = randomBytes(32).toString('base64url');
    const stateHash = hashState(state);
    const { verifier, challenge } = newPkcePair();
    await this.store.insertOAuthState({
      stateHash,
      visitorId,
      verifier: await seal(this.deps.env.encryption, verifier, pkceCtx(stateHash)),
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    });
    const url = buildAuthorizationUrl(fb, {
      state,
      codeChallenge: challenge,
      redirectUri: this.#redirectUri,
      scopes: SCAN_SCOPES,
    });
    return { authorizeUrl: url.href };
  }

  /** Never throws: every outcome is a /scan path on the web origin. */
  async complete(visitorId: string | null, query: unknown): Promise<{ redirectTo: string }> {
    const q = CallbackQuery.safeParse(query);
    if (!q.success) return failed('state_invalid');
    if (q.data.error !== undefined) return failed('declined');
    const { code, state } = q.data;
    if (visitorId === null || code === undefined || !state || !STATE_PATTERN.test(state))
      return failed('state_invalid');
    try {
      return await this.#exchange(visitorId, code, state);
    } catch (err) {
      const ce = err instanceof ConnectorError ? err : null;
      this.deps.log.warn('scan.oauth_failed', {
        visitorId,
        errorName: err instanceof Error ? err.name : 'NonError',
        ...(ce && { kind: ce.kind, errorCode: ce.code }),
      });
      return ce?.kind === 'transient' || ce?.kind === 'rate_limited'
        ? failed('platform_unavailable')
        : failed('internal');
    }
  }

  async #exchange(visitorId: string, code: string, state: string): Promise<{ redirectTo: string }> {
    const fb = this.#facebook();
    const keys = this.deps.env.encryption;
    const stateHash = hashState(state);
    // Visitor and expiry are checked in the same atomic delete: a foreign,
    // replayed or expired state reaches no Graph call.
    const sealed = await this.store.consumeOAuthState(stateHash, visitorId, new Date());
    if (!sealed) return failed('state_invalid');
    const codeVerifier = await open(keys, sealed.blob, pkceCtx(stateHash));

    const { tokens, account } = await exchangeCode(
      fb,
      Date.now,
      { code: new Secret(code), codeVerifier },
      {
        http: this.#http,
        signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
        redirectUri: this.#redirectUri,
      },
    );
    const missing = missingScopes(tokens.scopes);
    if (missing.length > 0) {
      this.deps.log.info('scan.oauth_missing_permissions', {
        visitorId,
        missingCount: missing.length,
      });
      return { redirectTo: `/scan?error=missing_permissions&missing=${missing.join(',')}` };
    }

    const graph: ScanGraph = {
      fb,
      ig: { meta: fb },
      meta: this.deps.env.metaAds ?? { meta: fb, activeStatuses: ['ACTIVE'] },
      http: readOnlyHttp(this.#http),
      nowMs: Date.now,
    };
    const pages = await listScanPages(
      graph,
      tokens.accessToken,
      AbortSignal.timeout(GRAPH_TIMEOUT_MS),
    );
    const grantId = randomUUID();
    const scanScopes = new Set<string>(SCAN_SCOPES);
    await this.store.insertGrant({
      id: grantId,
      visitorId,
      fbUserHash: createHash('sha256').update(account.externalAccountId).digest(),
      token: await seal(keys, tokens.accessToken, grantTokenCtx(grantId)),
      scopes: tokens.scopes.filter((s) => scanScopes.has(s)),
      pages,
      expiresAt: new Date(Date.now() + GRANT_TTL_MS),
    });
    this.deps.log.info('scan.grant_created', { visitorId, grantId, pageCount: pages.length });
    return { redirectTo: `/scan/pages/${grantId}` };
  }
}
