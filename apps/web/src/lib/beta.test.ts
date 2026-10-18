import { describe, expect, it } from 'vitest';
import { readBetaConfig } from './beta';

describe('readBetaConfig', () => {
  it('accepts https URL', () => {
    expect(readBetaConfig({ BETA_FEEDBACK_URL: 'https://forms.example/fb' }).feedbackUrl).toBe(
      'https://forms.example/fb',
    );
  });
  it.each([
    'http://forms.example/fb',
    'javascript:alert(1)',
    'data:text/html,hi',
    'https://user:pw@forms.example/fb',
    'https://user@forms.example/fb',
    'not a url',
  ])('rejects %s -> null', (value) => {
    expect(readBetaConfig({ BETA_FEEDBACK_URL: value }).feedbackUrl).toBeNull();
  });
  it('accepts plain email', () => {
    expect(readBetaConfig({ BETA_SUPPORT_EMAIL: 'help@example.com' }).supportEmail).toBe(
      'help@example.com',
    );
  });
  it.each(['a@b', 'x"@y.com', 'a@b.com<script>'])('rejects %s', (value) => {
    expect(readBetaConfig({ BETA_SUPPORT_EMAIL: value }).supportEmail).toBeNull();
  });
  it('both unset -> both null', () => {
    expect(readBetaConfig({})).toEqual({ feedbackUrl: null, supportEmail: null });
  });
});
