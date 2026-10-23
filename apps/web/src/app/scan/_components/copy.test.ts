import { SCAN_FAILURES } from '@feedbouncer/scan/contract';
import { describe, expect, it } from 'vitest';
import { errorCopy, scopeLabel } from './copy';

describe('scan copy', () => {
  it('maps every callback code and failure to a message', () => {
    for (const code of [
      'declined',
      'state_invalid',
      'missing_permissions',
      'platform_unavailable',
      'internal',
      ...SCAN_FAILURES,
    ]) {
      expect(errorCopy(code), code).toEqual(expect.any(String));
    }
  });

  it('anything else is null', () => {
    for (const code of ['<img>', '', 'constructor', '__proto__', null]) {
      expect(errorCopy(code)).toBeNull();
    }
  });

  it('labels only the four required scopes', () => {
    for (const s of [
      'pages_show_list',
      'pages_read_engagement',
      'pages_read_user_content',
      'ads_read',
    ]) {
      expect(scopeLabel(s)).toEqual(expect.any(String));
    }
    for (const s of ['evil', 'instagram_basic', 'toString']) expect(scopeLabel(s)).toBeNull();
  });
});
