'use client';
import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import type { Step } from '../../lib/onboarding';

/** The step's heading; it takes focus when the step appears so keyboard and screen reader users start here. */
export function StepHeading({ step }: { step: Step }) {
  const t = useTranslations('onboarding.steps');
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [step]);
  return (
    <h2 ref={ref} tabIndex={-1}>
      {t(step)}
    </h2>
  );
}
