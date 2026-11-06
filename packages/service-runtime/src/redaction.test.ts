import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { redact } from './redaction.js';

describe('redact', () => {
  it('redacts a platform provisioning token wherever it appears', () => {
    const token = `fbp_${randomBytes(32).toString('base64url')}`;
    const out = redact(`calling with credential ${token} now`);
    expect(out).not.toContain(token);
    expect(out).toContain('[redacted]');
  });
});
