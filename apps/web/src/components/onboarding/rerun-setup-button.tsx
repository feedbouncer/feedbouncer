'use client';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiFetch } from '../../lib/api-client';
import { onboardingHref } from '../../lib/onboarding';
import { Button } from '../ui/button';

export function RerunSetupButton({ orgId }: { orgId: string }) {
  const t = useTranslations('onboarding.setupCard');
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function onClick() {
    if (busy || !window.confirm(t('rerunConfirm'))) return;
    setBusy(true);
    setFailed(false);
    try {
      await apiFetch(`/api/v1/orgs/${orgId}/onboarding/rerun`, {
        method: 'POST',
        body: { confirm: true },
      });
    } catch {
      setFailed(true);
      setBusy(false);
      return;
    }
    router.push(onboardingHref(orgId, 'connect'));
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <Button type="button" variant="secondary" disabled={busy} onClick={onClick}>
        {t('rerun')}
      </Button>
      {failed ? <p role="alert">{t('rerunFailed')}</p> : null}
    </div>
  );
}
