import { describe, expect, it } from 'vitest';
import { actionFallbackCode, type ModerationActionView } from './actions.js';

const action = (status: ModerationActionView['status'], outcomeCode: string | null) =>
  ({ status, outcomeCode }) as ModerationActionView;

describe('actionFallbackCode', () => {
  it('is null when the action was accepted or is still pending', () => {
    expect(actionFallbackCode({ status: 'accepted', action: action('pending', null) })).toBeNull();
    expect(actionFallbackCode({ status: 'accepted', action: action('applied', null) })).toBeNull();
    expect(actionFallbackCode({ status: 'recorded', action: action('noop', null) })).toBeNull();
  });

  it('returns the refusal code, or a fixed word when it is not a closed code', () => {
    expect(actionFallbackCode({ status: 'refused', code: 'connection_inactive' })).toBe(
      'connection_inactive',
    );
    expect(actionFallbackCode({ status: 'refused', code: 'Bad Code' as never })).toBe('refused');
  });

  it('returns the outcome code for failed and recorded not_eligible actions', () => {
    expect(
      actionFallbackCode({ status: 'accepted', action: action('failed', 'platform_error') }),
    ).toBe('platform_error');
    expect(
      actionFallbackCode({ status: 'recorded', action: action('not_eligible', 'own_account') }),
    ).toBe('own_account');
    expect(actionFallbackCode({ status: 'accepted', action: action('failed', null) })).toBe(
      'failed',
    );
    expect(actionFallbackCode({ status: 'accepted', action: action('failed', 'Has spaces') })).toBe(
      'failed',
    );
  });
});
