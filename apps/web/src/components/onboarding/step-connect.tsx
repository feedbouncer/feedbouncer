'use client';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api-client';
import { messageFor, statusReasonText } from '../../lib/messages';
import {
  onboardingHref,
  ONBOARDING_RETURN_COOKIE,
  safeErrorCode,
  SELF_HOST_GUIDE_PATH,
  type OnboardingConnectionDto,
  type OnboardingStateDto,
} from '../../lib/onboarding';
import { PLATFORM_COPY, isConnectable } from '../../lib/platforms';
import { ApiForm } from '../api-form';
import { ConnectButton } from '../connect-button';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';

const platformLabel = (p: string): string => (isConnectable(p) ? PLATFORM_COPY[p].label : p);

export function StepConnect(props: {
  orgId: string;
  state: OnboardingStateDto;
  error: string | null;
}) {
  const t = useTranslations('onboarding.connect');
  const router = useRouter();
  const [continuing, setContinuing] = useState(false);
  const [continueFailed, setContinueFailed] = useState(false);
  const [brandFailed, setBrandFailed] = useState(false);
  const { state, orgId } = props;
  const errorCode = safeErrorCode(props.error);
  const brand = state.brand;

  // The OAuth round trip is over once this step renders.
  useEffect(() => {
    document.cookie = `${ONBOARDING_RETURN_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
  }, []);

  const canContinue = state.connections.some((c) => c.status === 'connected');

  async function onContinue() {
    if (continuing || !canContinue) return;
    setContinuing(true);
    setContinueFailed(false);
    try {
      await apiFetch(`/api/v1/orgs/${orgId}/onboarding/connect/complete`, {
        method: 'POST',
        body: {},
      });
    } catch {
      setContinueFailed(true);
      setContinuing(false);
      return;
    }
    router.push(onboardingHref(orgId, 'defaults'));
  }

  async function changeBrand(brandId: string) {
    setBrandFailed(false);
    try {
      await apiFetch(`/api/v1/orgs/${orgId}/onboarding/brand`, {
        method: 'PUT',
        body: { brandId },
      });
      router.refresh();
    } catch {
      setBrandFailed(true);
    }
  }

  function statusText(c: OnboardingConnectionDto): string {
    if (c.status === 'connected') return t('status.connected');
    if (c.status === 'pending') return t('status.pending');
    return c.needsReconnect ? t('status.expired') : t('status.failed');
  }

  if (brand === null) {
    return (
      <section className="flex flex-col gap-4">
        <p>{t('createBrandIntro')}</p>
        <ApiForm
          action={`/api/v1/orgs/${orgId}/brands`}
          fields={[{ name: 'name', label: t('createBrandLabel'), type: 'text' }]}
          submitLabel={t('createBrand')}
          variant="primary"
          refresh
        />
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      {state.brands.length > 1 ? (
        <label className="flex flex-col gap-(--fb-field-gap)">
          {t('brandLabel')}
          <select value={brand.id} onChange={(e) => void changeBrand(e.currentTarget.value)}>
            {state.brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {brandFailed ? <p role="alert">{t('brandChangeFailed')}</p> : null}
      {errorCode ? <p role="alert">{messageFor(errorCode)}</p> : null}
      {state.connections.length > 0 ? (
        <ul aria-label={t('connectionsLabel')} className="flex flex-col gap-3">
          {state.connections.map((c) => (
            <li key={c.id} className="flex flex-col items-start gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <strong>{c.displayName ?? t('unnamed')}</strong>
                <span>{platformLabel(c.platform)}</span>
                <Badge variant={c.status === 'connected' ? 'good' : 'danger'}>
                  {statusText(c)}
                </Badge>
              </div>
              {c.status !== 'connected' ? (
                <>
                  <p role="alert">{statusReasonText(c.statusReason ?? 'unknown')}</p>
                  {isConnectable(c.platform) ? (
                    <ConnectButton
                      orgId={orgId}
                      brandId={brand.id}
                      platform={c.platform}
                      label={t('tryAgain')}
                      reconnectConnectionId={c.id}
                      onboardingOrgId={orgId}
                    />
                  ) : null}
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {state.configuredPlatforms.length === 0 ? (
        <p>
          {t.rich('noPlatforms', {
            guide: (chunks) => <a href={SELF_HOST_GUIDE_PATH}>{chunks}</a>,
          })}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {state.configuredPlatforms.filter(isConnectable).map((p) => (
            <ConnectButton
              key={p}
              orgId={orgId}
              brandId={brand.id}
              platform={p}
              label={PLATFORM_COPY[p].connectLabel}
              onboardingOrgId={orgId}
            />
          ))}
        </div>
      )}
      <div className="flex flex-col items-start gap-2">
        <Button type="button" disabled={!canContinue || continuing} onClick={onContinue}>
          {t('continue')}
        </Button>
        {canContinue ? null : <p role="note">{t('needOne')}</p>}
        {continueFailed ? <p role="alert">{t('continueFailed')}</p> : null}
        <p>{t('addMoreLater')}</p>
      </div>
    </section>
  );
}
