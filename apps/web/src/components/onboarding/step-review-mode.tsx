'use client';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ApiRequestError, apiFetch } from '../../lib/api-client';
import { messageFor } from '../../lib/messages';
import { onboardingHref, type OnboardingStateDto } from '../../lib/onboarding';
import { Button } from '../ui/button';
import { StepHeading } from './step-heading';

type Choice = 'review' | 'automatic';

export function StepReviewMode(props: { orgId: string; state: OnboardingStateDto }) {
  const t = useTranslations('onboarding');
  const router = useRouter();
  const { orgId, state } = props;
  // Mirrors the API: review needs a window that is still running or can still start.
  const reviewUnavailable =
    !state.connections.some((c) => c.reviewMode === 'active') &&
    state.connections.some((c) => c.reviewMode !== 'off');
  const [choice, setChoice] = useState<Choice>(
    state.reviewModeChoice === 'automatic' || reviewUnavailable ? 'automatic' : 'review',
  );
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (saving || (choice === 'automatic' && !acknowledged)) return;
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/api/v1/orgs/${orgId}/onboarding/review-mode`, {
        method: 'PUT',
        body: choice === 'automatic' ? { choice, acknowledgeRisk: true } : { choice },
      });
    } catch (err) {
      setError(err instanceof ApiRequestError ? messageFor(err.code) : t('reviewMode.saveFailed'));
      setSaving(false);
      return;
    }
    router.push(onboardingHref(orgId, 'report'));
  }

  return (
    <section className="flex flex-col gap-4">
      <StepHeading step="review_mode" />
      <p>{t('reviewMode.intro')}</p>
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <fieldset className="flex flex-col gap-3">
          <legend>{t('reviewMode.legend')}</legend>
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="reviewMode"
              value="review"
              checked={choice === 'review'}
              disabled={reviewUnavailable}
              onChange={() => setChoice('review')}
            />
            <span>
              <strong>{t('reviewMode.review.label')}</strong>
              <br />
              {t('reviewMode.review.body')}
            </span>
          </label>
          {reviewUnavailable ? <p role="note">{t('reviewMode.reviewUnavailable')}</p> : null}
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="reviewMode"
              value="automatic"
              checked={choice === 'automatic'}
              onChange={() => setChoice('automatic')}
            />
            <span>
              <strong>{t('reviewMode.automatic.label')}</strong>
              <br />
              {t('reviewMode.automatic.body')}
            </span>
          </label>
        </fieldset>
        {choice === 'automatic' ? (
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              required
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.currentTarget.checked)}
            />
            {t('reviewMode.acknowledge')}
          </label>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        <Button type="submit" disabled={saving || (choice === 'automatic' && !acknowledged)}>
          {t('reviewMode.continue')}
        </Button>
      </form>
    </section>
  );
}
