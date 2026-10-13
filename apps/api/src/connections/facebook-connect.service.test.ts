import { describe, expect, it } from 'vitest';
import { viewStatus } from './connections.service.js';
import { callbackPath } from './facebook-connect.service.js';

const actor = {
  userId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  brandId: '33333333-3333-4333-8333-333333333333',
};
const connections = `/orgs/${actor.organizationId}/brands/${actor.brandId}/connections`;

describe('callbackPath', () => {
  it('maps every completion to a fixed web-app path', () => {
    const grantId = '44444444-4444-4444-8444-444444444444';
    expect(callbackPath(actor, { ok: true, kind: 'account_selection', grantId })).toBe(
      `${connections}/facebook/select?grant=${grantId}`,
    );
    expect(
      callbackPath(actor, { ok: true, kind: 'connected', connectionId: grantId, created: true }),
    ).toBe(connections);
    expect(callbackPath(actor, { ok: false, reason: 'denied' })).toBe(
      `${connections}?error=denied`,
    );
    expect(callbackPath(actor, { ok: false, reason: 'platform_error' })).toBe(
      `${connections}?error=platform_error`,
    );
    expect(callbackPath(actor, { ok: false, reason: 'rejected' })).toBe(
      '/orgs?error=oauth_rejected',
    );
    expect(callbackPath(null, { ok: false, reason: 'denied' })).toBe('/orgs?error=oauth_rejected');
  });

  it('lists only our own scope names as missing', () => {
    expect(
      callbackPath(actor, {
        ok: false,
        reason: 'missing_permissions',
        missing: ['pages_messaging', '../x?y=1', 'pages_manage_metadata', 'email'],
      }),
    ).toBe(
      `${connections}?error=missing_permissions&missing=pages_messaging,pages_manage_metadata`,
    );
  });
});

describe('viewStatus', () => {
  it('maps stored statuses to API statuses and hides abandoned or disconnected rows', () => {
    expect(viewStatus('active', null)).toBe('connected');
    expect(viewStatus('reconnect_required', 'oauth_access_rejected')).toBe('needs_reconnect');
    expect(viewStatus('reconnect_required', 'oauth_pending')).toBeNull();
    expect(viewStatus('revoked', 'user_disconnected')).toBeNull();
    expect(viewStatus('revoked', 'platform_revoked')).toBe('error');
    expect(viewStatus('paused', null)).toBe('paused');
    expect(viewStatus('error', 'x')).toBe('error');
    expect(viewStatus('something_new', null)).toBeNull();
  });
});
