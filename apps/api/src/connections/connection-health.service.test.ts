import { describe, expect, it } from 'vitest';
import { HEALTH_REASONS } from '@feedbouncer/observability';
import { boundedReason } from './connection-health.service.js';

describe('boundedReason', () => {
  it('echoes every reason in the health vocabulary', () => {
    for (const reason of HEALTH_REASONS) expect(boundedReason('degraded', reason)).toBe(reason);
  });

  it('never echoes a free-form stored reason', () => {
    expect(boundedReason('degraded', 'user@example.com said no')).toBe('connection_error');
    expect(boundedReason('needs_reconnection', 'something else')).toBe('reconnect_required');
    expect(boundedReason('degraded', 'credential_vault_down')).toBe('credential_unavailable');
  });
});
