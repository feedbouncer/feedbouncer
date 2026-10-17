import {
  assertAllowedUrl,
  ConnectorError,
  createSafeHttp,
  parseRetryAfter,
  type SafeHttp,
  type SafeHttpResponse,
} from '@feedbouncer/connectors';
import { SLACK_WEBHOOK_RE } from './channels.js';
import { CODE_RE, SLACK_TIMEOUT_MS } from './constants.js';
import type { SlackPayload } from './render.js';

export type SlackOutcome =
  | { ok: true }
  | {
      ok: false;
      kind: 'revoked' | 'rate_limited' | 'transient' | 'invalid';
      code: string;
      retryAfterMs?: number;
    };

const HOSTS = ['hooks.slack.com'];
const REVOKED_CODES = new Set([
  'action_prohibited',
  'invalid_token',
  'no_active_hooks',
  'no_service',
  'no_service_id',
  'no_team',
  'team_disabled',
  'channel_not_found',
  'channel_is_archived',
  'posting_to_general_channel_denied',
  'user_not_found',
]);

export function slackHttp(fetchImpl?: typeof fetch): SafeHttp {
  return createSafeHttp({
    allowedHosts: HOSTS,
    maxResponseBytes: 1024,
    ...(fetchImpl && { fetch: fetchImpl }),
  });
}

function classify(res: SafeHttpResponse, nowMs: number): SlackOutcome {
  const body = res.body.trim();
  const status = res.status;
  const code = CODE_RE.test(body) ? body : `http_${status}`;
  if (status === 404 || status === 410 || REVOKED_CODES.has(code)) {
    return { ok: false, kind: 'revoked', code };
  }
  if (status === 200 && body === 'ok') return { ok: true };
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), nowMs);
    return {
      ok: false,
      kind: 'rate_limited',
      code,
      ...(retryAfterMs !== null && { retryAfterMs }),
    };
  }
  if (status >= 500) return { ok: false, kind: 'transient', code };
  return { ok: false, kind: 'invalid', code };
}

/** Posts to a Slack incoming webhook. The URL never appears in the outcome, errors or logs. */
export async function postSlack(
  http: SafeHttp,
  url: URL,
  payload: SlackPayload,
  nowMs: () => number,
): Promise<SlackOutcome> {
  try {
    if (!SLACK_WEBHOOK_RE.test(url.href)) throw new TypeError();
    assertAllowedUrl(url, HOSTS);
  } catch {
    return { ok: false, kind: 'invalid', code: 'invalid_url' };
  }
  let res: SafeHttpResponse;
  try {
    res = await http.request(
      {
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
      AbortSignal.timeout(SLACK_TIMEOUT_MS),
    );
  } catch (err) {
    const timeout = err instanceof ConnectorError && err.code === 'timeout';
    const tooLarge = err instanceof ConnectorError && err.code === 'response_too_large';
    return {
      ok: false,
      kind: 'transient',
      code: timeout ? 'timeout' : tooLarge ? 'response_too_large' : 'network',
    };
  }
  return classify(res, nowMs());
}
