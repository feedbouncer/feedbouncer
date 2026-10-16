import { createFacebookConnector } from '@feedbouncer/connector-facebook';
import { createInstagramConnector } from '@feedbouncer/connector-instagram';
import type { ConnectorCapabilities, Platform } from '@feedbouncer/connectors';
import { describe, expect, it } from 'vitest';
import { REASON_CODES } from './steps.js';
import {
  checkStepsForBrand,
  stepOutcomeFor,
  stepSupport,
  type BrandConnectionInfo,
} from './support.js';

const fbCaps = createFacebookConnector({} as never).capabilities;
const igCaps = createInstagramConnector({ meta: {} } as never).capabilities;
const caps: Partial<Record<Platform, ConnectorCapabilities>> = {
  facebook: fbCaps,
  instagram: igCaps,
};

const FB_SCOPES = ['pages_manage_engagement', 'pages_messaging'];
const IG_SCOPES = ['instagram_manage_comments', 'instagram_manage_messages'];
const fb = (grantedScopes: readonly string[] = FB_SCOPES): BrandConnectionInfo => ({
  connectionId: 'c-fb',
  platform: 'facebook',
  grantedScopes,
  caps: fbCaps,
});
const ig = (grantedScopes: readonly string[] = IG_SCOPES): BrandConnectionInfo => ({
  connectionId: 'c-ig',
  platform: 'instagram',
  grantedScopes,
  caps: igCaps,
});

describe('stepSupport', () => {
  it('ban on instagram is unsupported', () => {
    expect(stepSupport('ban', ig())).toEqual({ supported: false });
    expect(stepSupport('ban', fb())).toEqual({
      supported: true,
      missingScopes: [],
      maxChars: null,
    });
  });

  it('private_reply on IG without instagram_manage_messages lists the missing scope', () => {
    expect(stepSupport('private_reply', ig(['instagram_manage_comments']))).toEqual({
      supported: true,
      missingScopes: ['instagram_manage_messages'],
      maxChars: 1000,
    });
  });

  it('auto_reply maxChars is 2200 on IG, 8000 on FB', () => {
    expect(stepSupport('auto_reply', ig())).toMatchObject({ maxChars: 2200 });
    expect(stepSupport('auto_reply', fb())).toMatchObject({ maxChars: 8000 });
  });

  it('flag_for_review is always supported and needs no scopes', () => {
    expect(stepSupport('flag_for_review', ig([]))).toEqual({
      supported: true,
      missingScopes: [],
      maxChars: null,
    });
  });
});

describe('checkStepsForBrand', () => {
  const ban = { type: 'ban', confirmHardToReverse: true } as const;

  it('ban on an IG-only brand is an error', () => {
    expect(checkStepsForBrand([ban], [ig()])).toEqual({
      errors: [{ index: 0, type: 'ban', code: 'not_supported_anywhere' }],
      warnings: [],
    });
  });

  it('ban on FB+IG brand warns for instagram', () => {
    const r = checkStepsForBrand([ban], [fb(), ig()]);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([
      {
        type: 'ban',
        code: 'not_supported_on_platform',
        platform: 'instagram',
        connectionId: 'c-ig',
      },
    ]);
  });

  it('a 2160-char template with a variable is too long for IG', () => {
    const step = { type: 'auto_reply', template: `${'a'.repeat(2160)}{{author_name}}` } as const;
    const r = checkStepsForBrand([step], [ig()]);
    expect(r.errors).toEqual([
      { index: 0, type: 'auto_reply', code: 'template_too_long', platform: 'instagram', max: 2200 },
    ]);
    expect(checkStepsForBrand([step], [fb()]).errors).toEqual([]);
  });

  it('an author rule on instagram with ban is an error', () => {
    const r = checkStepsForBrand([ban], [fb(), ig()], 'instagram');
    expect(r.errors).toEqual([{ index: 0, type: 'ban', code: 'not_supported_anywhere' }]);
    expect(r.warnings).toEqual([]);
  });

  it('warns about missing scopes', () => {
    const r = checkStepsForBrand([{ type: 'hide' }], [fb(['pages_messaging'])]);
    expect(r.warnings).toEqual([
      {
        type: 'hide',
        code: 'missing_permission',
        platform: 'facebook',
        connectionId: 'c-fb',
        scopes: ['pages_manage_engagement'],
      },
    ]);
  });

  it('without connections checks the registry capabilities of facebook and instagram', () => {
    const r = checkStepsForBrand([ban], [], undefined, (p) => caps[p]);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(checkStepsForBrand([ban], [], 'instagram', (p) => caps[p]).errors).toHaveLength(1);
  });
});

describe('stepOutcomeFor', () => {
  const action = (status: string, code: string | null) =>
    ({ kind: 'action', status, code }) as never;
  const refused = (code: string) => ({ kind: 'refused', code }) as const;
  const ok = (status: string, reason: string | null) => ({ status, reason });

  it.each([
    [action('applied', null), ok('succeeded', null)],
    [action('pending', null), ok('pending', null)],
    [action('deferred', 'budget_exhausted'), ok('pending', 'rate_limited')],
    [action('deferred', 'platform_throttled'), ok('pending', 'rate_limited')],
    [action('deferred', 'token_expired'), ok('pending', 'awaiting_reconnect')],
    [action('deferred', null), ok('pending', 'awaiting_reconnect')],
    [action('noop', 'comment_gone'), ok('not_applicable', 'comment_gone')],
    [action('noop', 'already_deleted'), ok('not_applicable', 'comment_gone')],
    [refused('not_found'), ok('not_applicable', 'comment_gone')],
    [action('noop', 'already_hidden'), ok('skipped', 'already_hidden')],
    [action('noop', 'already_visible'), ok('skipped', 'already_visible')],
    [action('not_eligible', 'author_unavailable'), ok('not_applicable', 'author_unavailable')],
    [action('not_eligible', 'author_is_page'), ok('not_applicable', 'author_is_page')],
    [
      action('not_eligible', 'private_reply_window_closed'),
      ok('not_applicable', 'private_reply_window_closed'),
    ],
    [
      action('not_eligible', 'private_reply_nested_comment'),
      ok('not_applicable', 'private_reply_nested_comment'),
    ],
    [
      action('not_eligible', 'reply_to_hidden_comment'),
      ok('not_applicable', 'reply_to_hidden_comment'),
    ],
    [
      action('not_eligible', 'own_comment_always_visible'),
      ok('not_applicable', 'own_comment_always_visible'),
    ],
    [action('not_eligible', 'own_account_comment'), ok('skipped', 'own_account_comment')],
    [
      action('not_eligible', 'private_reply_already_sent'),
      ok('skipped', 'private_reply_already_sent'),
    ],
    [action('not_eligible', 'ban_limit_reached'), ok('failed', 'ban_limit_reached')],
    [action('not_eligible', 'reblock_too_soon'), ok('failed', 'reblock_too_soon')],
    [action('not_eligible', 'author_not_bannable'), ok('failed', 'author_not_bannable')],
    [action('failed', 'unsupported'), ok('not_supported', 'unsupported')],
    [refused('unsupported'), ok('not_supported', 'unsupported')],
    [action('failed', 'permission_denied'), ok('failed', 'missing_permission')],
    [action('failed', 'permission_revoked'), ok('failed', 'missing_permission')],
    [action('failed', 'private_reply_not_permitted'), ok('failed', 'missing_permission')],
    [action('failed', 'not_found'), ok('not_applicable', 'author_gone')],
    [refused('text_too_long'), ok('failed', 'text_too_long')],
    [action('failed', 'something_odd'), ok('failed', 'something_odd')],
    [action('failed', 'Bad Code!'), ok('failed', 'failed')],
    [action('failed', null), ok('failed', 'failed')],
    [refused('connection_inactive'), ok('failed', 'connection_inactive')],
    [refused('review_mode_active'), ok('skipped', 'review_mode_active')],
    [refused('moderator_override'), ok('skipped', 'moderator_override')],
  ])('%j -> %j', (input, expected) => {
    expect(stepOutcomeFor(input)).toEqual(expected);
    if (
      expected.reason !== null &&
      expected.reason !== 'failed' &&
      expected.reason !== 'something_odd'
    )
      expect(REASON_CODES).toContain(expected.reason);
  });
});

describe('REASON_CODES', () => {
  it('are closed snake_case codes', () => {
    expect(REASON_CODES.length).toBeGreaterThan(30);
    for (const c of REASON_CODES) expect(c).toMatch(/^[a-z][a-z0-9_]{0,62}$/);
    expect(new Set(REASON_CODES).size).toBe(REASON_CODES.length);
  });

  it('include the codes other tasks emit and every code the mapping can return', () => {
    for (const c of [
      'moderator_override',
      'reply_thread_limit',
      'duplicate',
      'already_flagged',
      'would_run',
      'internal_error',
      'missing_permission',
      'unsupported',
      'comment_gone',
      'own_account_comment',
      'rate_limited',
      'awaiting_reconnect',
      'rate_limit_exhausted',
      'retries_exhausted',
      'author_gone',
      'text_too_long',
      'own_comment_always_visible',
      'reply_too_long',
      'connection_needs_reconnect',
      'connection_inactive',
      'request_key_conflict',
    ])
      expect(REASON_CODES).toContain(c);
  });
});
