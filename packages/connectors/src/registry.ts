import type { Connector } from './connector.js';
import { ConnectorError } from './errors.js';
import { isPlatform, MODERATION_ACTIONS, type Platform } from './types.js';

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
    !int(rl.defaultRetryAfterMs, 1_000, 86_400_000)
  )
    fail('capabilities.rateLimit');
  for (const field of ['apiHosts', 'authorizationHosts'] as const)
    if (k[field].length === 0 || !k[field].every((h) => HOST.test(h)))
      fail(`capabilities.${field}`);
  if (!int(k.maxPageSize, 1, 500)) fail('capabilities.maxPageSize');
  if (k.tokens.rotatesRefreshToken && !k.tokens.refreshable) fail('capabilities.tokens');
  if (k.listSources !== (typeof c.listSources === 'function')) fail('capabilities.listSources');
  const wantsWebhook = k.ingestion !== 'polling';
  if (wantsWebhook !== (c.webhook !== undefined)) fail('webhook');
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
