import { describe, expect, it } from 'vitest';
import {
  onboardingHref,
  onboardingReturnCookie,
  parseStep,
  safeErrorCode,
  STEPS,
} from './onboarding';

describe('onboarding helpers', () => {
  it('parseStep accepts only known steps', () => {
    expect(parseStep('report')).toBe('report');
    expect(parseStep('../x')).toBeNull();
    expect(parseStep(undefined)).toBeNull();
    expect(STEPS).toEqual(['connect', 'defaults', 'review_mode', 'report']);
  });

  it('safeErrorCode passes only snake_case codes', () => {
    expect(safeErrorCode('<script>')).toBeNull();
    expect(safeErrorCode('oauth_denied')).toBe('oauth_denied');
    expect(safeErrorCode('Oauth')).toBeNull();
    expect(safeErrorCode('a'.repeat(65))).toBeNull();
    expect(safeErrorCode(['x'])).toBeNull();
  });

  it('onboardingHref builds server-side paths', () => {
    expect(onboardingHref('o1')).toBe('/orgs/o1/onboarding');
    expect(onboardingHref('o1', 'review_mode')).toBe('/orgs/o1/onboarding/review_mode');
  });
});

describe('onboardingReturnCookie', () => {
  it('lives for 30 minutes, site-wide, Lax', () => {
    expect(onboardingReturnCookie('o1')).toBe(
      'fb_onboarding_return=o1; Path=/; Max-Age=1800; SameSite=Lax',
    );
  });
});
