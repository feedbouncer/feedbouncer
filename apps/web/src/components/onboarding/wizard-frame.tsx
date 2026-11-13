'use client';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { apiFetch } from '../../lib/api-client';
import { onboardingHref, STEPS, type OnboardingStateDto, type Step } from '../../lib/onboarding';
import { BackLink } from '../ui/back-link';
import { Button } from '../ui/button';
import { Progress } from './progress';

export function WizardFrame({
  orgId,
  state,
  step,
  children,
}: {
  orgId: string;
  state: OnboardingStateDto;
  step: Step;
  children: ReactNode;
}) {
  const t = useTranslations('onboarding');
  const router = useRouter();
  const [skipFailed, setSkipFailed] = useState(false);
  const [startFailed, setStartFailed] = useState(false);
  const started = useRef(false);
  const previous = STEPS[STEPS.indexOf(step) - 1];

  // The page never mutates on GET: the first visit starts the wizard from the browser, once.
  useEffect(() => {
    if (state.started || started.current) return;
    started.current = true;
    apiFetch(`/api/v1/orgs/${orgId}/onboarding/start`, { method: 'POST' }).then(
      () => router.refresh(),
      () => setStartFailed(true),
    );
  }, [state.started, orgId, router]);

  async function skip() {
    setSkipFailed(false);
    try {
      await apiFetch(`/api/v1/orgs/${orgId}/onboarding/dismiss`, { method: 'POST' });
    } catch {
      setSkipFailed(true);
      return;
    }
    router.push(`/orgs/${orgId}`);
  }

  return (
    <div className="flex flex-col gap-6">
      {previous ? <BackLink href={onboardingHref(orgId, previous)}>{t('back')}</BackLink> : null}
      <Progress steps={state.steps} current={step} orgId={orgId} />
      {startFailed ? <p role="alert">{t('startFailed')}</p> : null}
      {children}
      <div className="flex items-center gap-3">
        <Button type="button" variant="ghost" size="sm" onClick={skip}>
          {t('skip')}
        </Button>
        {skipFailed ? <p role="alert">{t('skipFailed')}</p> : null}
      </div>
    </div>
  );
}
