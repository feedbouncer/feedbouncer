'use client';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ApiRequestError, apiFetch } from '../../lib/api-client';
import { messageFor } from '../../lib/messages';
import {
  onboardingHref,
  type DefaultCategoryDto,
  type OnboardingDefaultsDto,
} from '../../lib/onboarding';
import { Button } from '../ui/button';
import { StepHeading } from './step-heading';

const ACTIONS = ['hide', 'flag', 'approve'] as const;
type Choice = (typeof ACTIONS)[number];

const isCategoryList = (v: unknown): v is DefaultCategoryDto[] =>
  Array.isArray(v) &&
  v.every(
    (c) =>
      typeof c === 'object' &&
      c !== null &&
      typeof (c as { category?: unknown }).category === 'string',
  );

export function StepDefaults(props: {
  orgId: string;
  initial: OnboardingDefaultsDto;
  /** Used for the classifier settings link; without it the link goes to the organization page. */
  brandId?: string | undefined;
}) {
  const t = useTranslations('onboarding');
  const router = useRouter();
  const { orgId } = props;
  const [view, setView] = useState(props.initial);
  const [picked, setPicked] = useState<Record<string, Choice>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const classifierHref = props.brandId
    ? `/orgs/${orgId}/brands/${props.brandId}/classifier`
    : `/orgs/${orgId}`;

  const valueOf = (c: DefaultCategoryDto): string => picked[c.category] ?? c.action;
  const known = (c: DefaultCategoryDto) => t.has(`category.${c.category}.name`);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    const choices = view.categories
      .filter((c) => c.action !== 'remove')
      .map((c) => ({ category: c.category, action: valueOf(c) }));
    try {
      await apiFetch(`/api/v1/orgs/${orgId}/onboarding/defaults`, {
        method: 'PUT',
        body: { choices, basedOn: view.basedOn },
      });
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'onboarding_defaults_stale') {
        setPicked({});
        const fromError = isCategoryList(err.categories) ? err.categories : null;
        // The refusal carries the current categories but not the fingerprint the next save needs.
        const fresh = await apiFetch<OnboardingDefaultsDto>(
          `/api/v1/orgs/${orgId}/onboarding/defaults`,
        ).catch(() => null);
        if (fresh) setView(fresh);
        else if (fromError) setView({ ...view, categories: fromError });
        setError(messageFor('onboarding_defaults_stale'));
      } else {
        setError(err instanceof ApiRequestError ? messageFor(err.code) : t('defaults.saveFailed'));
      }
      setSaving(false);
      return;
    }
    router.push(onboardingHref(orgId, 'review_mode'));
  }

  return (
    <section className="flex flex-col gap-4">
      <StepHeading step="defaults" />
      <p>{t('defaults.intro')}</p>
      {view.aiEnabled ? null : <p role="note">{t('defaults.aiOff')}</p>}
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        {view.categories.filter(known).map((c) => (
          <fieldset key={c.category} className="flex flex-col gap-2">
            <legend>{t(`category.${c.category}.name`)}</legend>
            <p className="text-small text-dim">{t(`category.${c.category}.description`)}</p>
            {c.action === 'remove' ? (
              <p>
                {t.rich('defaults.removeNote', {
                  link: (chunks) => <a href={classifierHref}>{chunks}</a>,
                })}
              </p>
            ) : (
              ACTIONS.map((a) => (
                <label key={a} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={`category-${c.category}`}
                    value={a}
                    checked={valueOf(c) === a}
                    onChange={() => setPicked({ ...picked, [c.category]: a })}
                  />
                  {t(`action.${a}`)}
                </label>
              ))
            )}
          </fieldset>
        ))}
        {error ? <p role="alert">{error}</p> : null}
        <Button type="submit" disabled={saving}>
          {t('defaults.continue')}
        </Button>
      </form>
    </section>
  );
}
