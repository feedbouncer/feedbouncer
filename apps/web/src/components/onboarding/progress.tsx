import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { cn } from '../../lib/utils';
import {
  isReachable,
  onboardingHref,
  STEPS,
  type Step,
  type StepStatuses,
} from '../../lib/onboarding';

export function Progress({
  steps,
  current,
  orgId,
}: {
  steps: StepStatuses;
  current: Step;
  orgId: string;
}) {
  const t = useTranslations('onboarding');
  return (
    <div className="flex flex-col gap-2">
      <p className="text-small text-dim">
        {t('progress.stepOf', { current: STEPS.indexOf(current) + 1, total: STEPS.length })}
      </p>
      <ol aria-label={t('progress.label')} className="flex flex-wrap gap-x-4 gap-y-1">
        {STEPS.map((step) => {
          const label = t(`steps.${step}`);
          const isCurrent = step === current;
          const linkable = !isCurrent && isReachable(steps, step);
          const cls = cn(
            'text-small',
            isCurrent ? 'font-semibold text-foreground' : 'text-dim',
            !isCurrent && !linkable && 'opacity-60',
          );
          return (
            <li key={step}>
              {linkable ? (
                <Link
                  href={onboardingHref(orgId, step)}
                  className={cn(cls, 'hover:text-foreground')}
                >
                  {label}
                </Link>
              ) : (
                <span
                  className={cls}
                  {...(isCurrent ? { 'aria-current': 'step' as const } : { 'aria-disabled': true })}
                >
                  {label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
