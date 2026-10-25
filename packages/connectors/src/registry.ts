import type { Connector } from './connector.js';
import { ConnectorError } from './errors.js';
import {
  isPlatform,
  MODERATION_ACTIONS,
  RESPONSE_KINDS,
  type Platform,
  type ResponseKind,
} from './types.js';

const HOST =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const HEADER = /^[a-z0-9-]{1,64}$/;
const int = (n: unknown, min: number, max: number) =>
  typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;
const fail = (field: string): never => {
  throw new TypeError(`Invalid connector definition: ${field}`);
};

export function validateConnector(c: Connector): void {
  if (!isPlatform(c.platform)) fail('platform');
  const k = c.capabilities;
  const actions = new Set(k.actions);
  if (
    actions.size !== k.actions.length ||
    k.actions.some((a) => !(MODERATION_ACTIONS as readonly string[]).includes(a))
  )
    fail('capabilities.actions');
  const rl = k.rateLimit;
  if (
    !int(rl.points, 1, 1_000_000) ||
    !int(rl.durationSec, 1, 86_400) ||
    !int(rl.urgentReservePoints, 0, rl.points - 1) ||
    !int(rl.defaultRetryAfterMs, 1_000, 86_400_000) ||
    (rl.backgroundPoints !== undefined &&
      !int(rl.backgroundPoints, 1, rl.points - rl.urgentReservePoints))
  )
    fail('capabilities.rateLimit');
  for (const field of ['apiHosts', 'authorizationHosts'] as const)
    if (k[field].length === 0 || !k[field].every((h) => HOST.test(h)))
      fail(`capabilities.${field}`);
  if (!int(k.maxPageSize, 1, 500)) fail('capabilities.maxPageSize');
  if (k.tokens.rotatesRefreshToken && !k.tokens.refreshable) fail('capabilities.tokens');
  if (k.listSources !== (typeof c.listSources === 'function')) fail('capabilities.listSources');
  if (k.recentSources !== (typeof c.listRecentSources === 'function'))
    fail('capabilities.recentSources');
  if ((k.adLookup ?? false) !== (typeof c.lookupAd === 'function')) fail('capabilities.adLookup');
  if ((k.connectionComments ?? false) !== (typeof c.listConnectionComments === 'function'))
    fail('capabilities.connectionComments');
  if (k.accountIdPattern !== undefined && !(k.accountIdPattern instanceof RegExp))
    fail('capabilities.accountIdPattern');
  if (
    k.oauthCodeParam !== undefined &&
    k.oauthCodeParam !== 'code' &&
    k.oauthCodeParam !== 'auth_code'
  )
    fail('capabilities.oauthCodeParam');
  const wantsWebhook = k.ingestion !== 'polling';
  if (wantsWebhook !== (c.webhook !== undefined)) fail('webhook');
  if (k.requiredScopes !== undefined && !k.requiredScopes.every((s) => k.defaultScopes.includes(s)))
    fail('capabilities.requiredScopes');
  const selection = k.accountSelection ?? 'single';
  if (selection !== 'single' && selection !== 'multiple') fail('capabilities.accountSelection');
  if ((selection === 'multiple') !== (typeof c.listAccounts === 'function'))
    fail('capabilities.accountSelection');
  const responses = k.responses ?? [];
  if (
    new Set(responses).size !== responses.length ||
    responses.some((r) => !(RESPONSE_KINDS as readonly string[]).includes(r))
  )
    fail('capabilities.responses');
  if (responses.length > 0 !== (typeof c.respond === 'function')) fail('capabilities.responses');
  if (
    k.responsePriority !== undefined &&
    !(['urgent', 'bulk', 'background'] as readonly string[]).includes(k.responsePriority)
  )
    fail('capabilities.responsePriority');
  if (c.listReplies !== undefined && typeof c.listReplies !== 'function') fail('listReplies');
  if (c.verifySourceOwner !== undefined && typeof c.verifySourceOwner !== 'function')
    fail('verifySourceOwner');
  if (c.probeComments !== undefined && typeof c.probeComments !== 'function') fail('probeComments');
  if (c.listThreads !== undefined && typeof c.listThreads !== 'function') fail('listThreads');
  if (c.probeThreadReplyCounts !== undefined && typeof c.probeThreadReplyCounts !== 'function')
    fail('probeThreadReplyCounts');
  const dispatch = k.actionDispatch ?? 'immediate';
  if (dispatch !== 'immediate' && dispatch !== 'budgeted') fail('capabilities.actionDispatch');
  if (
    dispatch === 'budgeted' &&
    (typeof c.actBatch !== 'function' || typeof c.probeComments !== 'function')
  )
    fail('capabilities.actionDispatch');
  if (k.batchActions !== undefined && !int(k.batchActions.maxTargets, 1, 500))
    fail('capabilities.batchActions');
  if ((k.batchActions !== undefined) !== (typeof c.actBatch === 'function'))
    fail('capabilities.batchActions');
  const constraints = k.constraints;
  if (constraints !== undefined) {
    const posInt = (n: unknown) => Number.isSafeInteger(n) && (n as number) > 0;
    if (constraints.privateReplyWindowMs !== undefined && !posInt(constraints.privateReplyWindowMs))
      fail('capabilities.constraints');
    for (const [kind, n] of Object.entries(constraints.maxReplyChars ?? {})) {
      if (!responses.includes(kind as ResponseKind) || !posInt(n) || (n as number) > 8000)
        fail('capabilities.constraints');
    }
  }
  if (
    c.lifecycle !== undefined &&
    (typeof c.lifecycle.onConnected !== 'function' ||
      typeof c.lifecycle.onDisconnected !== 'function')
  )
    fail('lifecycle');
  if (c.webhook) {
    const s = c.webhook.signature;
    if (!HEADER.test(s.header)) fail('webhook.signature.header');
    if (s.timestampHeader !== null && !HEADER.test(s.timestampHeader))
      fail('webhook.signature.timestampHeader');
    if (s.timestampHeader !== null && !int(c.webhook.toleranceSec, 1, 600))
      fail('webhook.toleranceSec');
  }
}

export class ConnectorRegistry {
  readonly #byPlatform = new Map<Platform, Connector>();

  register(c: Connector): void {
    validateConnector(c);
    if (this.#byPlatform.has(c.platform))
      throw new Error(`A connector for ${c.platform} is already registered`);
    this.#byPlatform.set(c.platform, c);
  }

  get(p: Platform): Connector | undefined {
    return this.#byPlatform.get(p);
  }

  require(p: Platform): Connector {
    const c = this.#byPlatform.get(p);
    if (!c) throw new ConnectorError('unsupported', 'platform_not_registered');
    return c;
  }

  platforms(): Platform[] {
    return [...this.#byPlatform.keys()];
  }
}
