'use client';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api-client';
import type { OnboardingReportDto } from '../../lib/onboarding';
import { PLATFORM_COPY, isConnectable } from '../../lib/platforms';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { StatCard, StatGrid } from '../ui/stat';
import { StepHeading } from './step-heading';

const POLL_MS = 5000;
const platformLabel = (p: string): string => (isConnectable(p) ? PLATFORM_COPY[p].label : p);

export function StepReport(props: { orgId: string; initial: OnboardingReportDto }) {
  const t = useTranslations('onboarding');
  const { orgId } = props;
  const [report, setReport] = useState(props.initial);
  const [finishing, setFinishing] = useState(false);
  const [finished, setFinished] = useState(false);
  const [finishFailed, setFinishFailed] = useState(false);
  const [syncFailed, setSyncFailed] = useState(false);
  const syncing = report.sync === 'syncing';

  useEffect(() => {
    if (!syncing) return;
    let inFlight = false;
    let active = true;
    const id = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      apiFetch<OnboardingReportDto>(`/api/v1/orgs/${orgId}/onboarding/report`)
        .then(
          (r) => {
            if (!active) return;
            setReport(r);
            setSyncFailed(false);
          },
          () => {
            if (active) setSyncFailed(true);
          },
        )
        .finally(() => {
          inFlight = false;
        });
    }, POLL_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [syncing, orgId]);

  async function onFinish() {
    if (finishing) return;
    setFinishing(true);
    setFinishFailed(false);
    try {
      await apiFetch(`/api/v1/orgs/${orgId}/onboarding/report/complete`, {
        method: 'POST',
        body: {},
      });
    } catch {
      setFinishFailed(true);
      setFinishing(false);
      return;
    }
    setFinished(true);
  }

  const categoryName = (c: string): string =>
    t.has(`category.${c}.name`) ? t(`category.${c}.name`) : c;
  const actionName = (a: string): string => (t.has(`action.${a}`) ? t(`action.${a}`) : a);
  const mode = report.reviewModeChoice ?? 'none';
  const imported = report.accounts.reduce((n, a) => n + a.imported, 0);

  return (
    <section className="flex flex-col gap-4">
      <StepHeading step="report" />
      <p>{t('report.reviewMode', { mode: t(`report.mode.${mode}`) })}</p>
      <div>
        <h3>{t('report.defaultsLabel')}</h3>
        {report.defaults.length > 0 ? (
          <ul>
            {report.defaults.map((d) => (
              <li key={d.category}>
                {t('report.defaultItem', {
                  category: categoryName(d.category),
                  action: actionName(d.action),
                })}
              </li>
            ))}
          </ul>
        ) : (
          <p>{t('report.defaultsNone')}</p>
        )}
      </div>
      <div aria-live="polite">
        {syncing ? <p>{t('report.syncing', { count: imported })}</p> : null}
      </div>
      {syncFailed ? <p role="alert">{t('report.syncFailed')}</p> : null}
      {report.sync === 'no_connections' ? <p role="note">{t('report.noConnections')}</p> : null}
      {report.empty ? <p>{t('report.empty')}</p> : null}
      <StatGrid>
        <StatCard label={t('report.totals.comments')} value={report.totals.comments} />
        <StatCard label={t('report.totals.hidden')} value={report.totals.hidden} />
        <StatCard label={t('report.totals.replied')} value={report.totals.replied} />
        <StatCard label={t('report.totals.unanswered')} value={report.totals.unanswered} />
      </StatGrid>
      <ul className="flex flex-col gap-4">
        {report.accounts.map((a) => (
          <li key={a.connectionId}>
            <Card>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-baseline gap-2">
                  <span>{a.displayName ?? t('report.account.unnamed')}</span>
                  <span className="text-small text-dim">{platformLabel(a.platform)}</span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-5">
                  <dt>{t('report.account.comments')}</dt>
                  <dd>{a.comments}</dd>
                  <dt>{t('report.account.imported')}</dt>
                  <dd>{a.imported}</dd>
                  <dt>{t('report.account.checked')}</dt>
                  <dd>{a.checked}</dd>
                  <dt>{t('report.account.hidden')}</dt>
                  <dd>{a.hidden}</dd>
                  <dt>{t('report.account.awaitingReview')}</dt>
                  <dd>{a.awaitingReview}</dd>
                </dl>
                <p>
                  {t('report.account.topCategoriesLine', {
                    list:
                      a.topCategories.length > 0
                        ? a.topCategories
                            .map((c) =>
                              t('report.account.categoryCount', {
                                category: categoryName(c.category),
                                count: c.count,
                              }),
                            )
                            .join(', ')
                        : t('report.account.topCategoriesNone'),
                  })}
                </p>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
      {finished ? (
        <p>
          {t.rich('report.done', {
            dashboard: (chunks) => <a href={`/orgs/${orgId}`}>{chunks}</a>,
          })}
        </p>
      ) : (
        <div className="flex flex-col items-start gap-2">
          <Button type="button" disabled={finishing} onClick={onFinish}>
            {t('report.finish')}
          </Button>
          {finishFailed ? <p role="alert">{t('report.finishFailed')}</p> : null}
        </div>
      )}
    </section>
  );
}
