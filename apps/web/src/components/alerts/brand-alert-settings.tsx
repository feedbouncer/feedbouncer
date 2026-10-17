'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  ALERT_TYPES,
  COOLDOWNS,
  SENSITIVITIES,
  channelName,
  type AlertRouteDto,
  type BrandAlertsView,
  type ContentMode,
  type Sensitivity,
} from '../../lib/alerts';
import { ApiRequestError, apiFetch } from '../../lib/api-client';
import { messageFor } from '../../lib/messages';

const key = (type: string, channelId: string) => `${type}:${channelId}`;

export function BrandAlertSettings(props: {
  orgId: string;
  brandId: string;
  view: BrandAlertsView;
  canManage: boolean;
}) {
  const { view } = props;
  const router = useRouter();
  const shown = view.channels.filter(
    (c) => c.status === 'active' || c.status === 'pending_confirmation',
  );
  const [enabled, setEnabled] = useState(
    () => new Set(view.routes.filter((r) => r.enabled).map((r) => key(r.alertType, r.channelId))),
  );
  const [sensitivity, setSensitivity] = useState<Sensitivity>(view.settings.sensitivity);
  const [minCount, setMinCount] = useState(String(view.settings.minNegativeCount));
  const [cooldown, setCooldown] = useState(String(view.settings.cooldownMinutes));
  const [contentMode, setContentMode] = useState<ContentMode>(view.settings.contentMode);
  const [status, setStatus] = useState<{ kind: 'idle' | 'busy' | 'ok' | 'error'; text?: string }>({
    kind: 'idle',
  });

  function toggle(k: string, on: boolean) {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (on) next.add(k);
      else next.delete(k);
      return next;
    });
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus({ kind: 'busy' });
    const kinds = new Map(view.channels.map((c) => [c.id, c.kind] as const));
    const shownIds = new Set(shown.map((c) => c.id));
    // The API replaces the whole route set, so routes for channels not in the matrix are kept.
    // Routes of a kind this server can't send are saved switched off.
    const routes: AlertRouteDto[] = view.routes
      .filter((r) => !shownIds.has(r.channelId) && kinds.has(r.channelId))
      .map((r) => ({
        ...r,
        enabled: r.enabled && view.availability[kinds.get(r.channelId)!],
      }));
    for (const c of shown) {
      for (const t of ALERT_TYPES) {
        routes.push({
          alertType: t.type,
          channelId: c.id,
          enabled: view.availability[c.kind] && enabled.has(key(t.type, c.id)),
        });
      }
    }
    try {
      await apiFetch(`/api/v1/orgs/${props.orgId}/brands/${props.brandId}/alerts`, {
        method: 'PUT',
        body: {
          settings: {
            sensitivity,
            minNegativeCount: Number(minCount),
            cooldownMinutes: Number(cooldown),
            contentMode,
          },
          routes,
        },
      });
      setStatus({ kind: 'ok', text: 'Saved.' });
      router.refresh();
    } catch (err) {
      setStatus({
        kind: 'error',
        text: err instanceof ApiRequestError ? messageFor(err.code) : 'Something went wrong.',
      });
    }
  }

  return (
    <form onSubmit={onSubmit}>
      <fieldset disabled={!props.canManage}>
        {view.learning ? (
          <p>Spike alerts start after 7 days of comment history for this brand.</p>
        ) : null}
        {shown.length === 0 ? (
          <p>
            No channels yet. Connect Slack or add an email recipient on the workspace Alerts page.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Alert</th>
                {shown.map((c) => (
                  <th key={c.id} scope="col">
                    {channelName(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ALERT_TYPES.map((t) => (
                <tr key={t.type}>
                  <th scope="row">{t.label}</th>
                  {shown.map((c) => (
                    <td key={c.id}>
                      <input
                        type="checkbox"
                        aria-label={`${t.label} to ${channelName(c)}`}
                        checked={enabled.has(key(t.type, c.id))}
                        disabled={!view.availability[c.kind]}
                        onChange={(e) => toggle(key(t.type, c.id), e.target.checked)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <label style={{ display: 'block', marginBottom: 8 }}>
          Spike sensitivity{' '}
          <select
            value={sensitivity}
            onChange={(e) => setSensitivity(e.target.value as Sensitivity)}
          >
            {SENSITIVITIES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <p>Higher sensitivity alerts on smaller rises above this brand&apos;s usual level.</p>
        <label style={{ display: 'block', marginBottom: 8 }}>
          Minimum negative comments in an hour{' '}
          <input
            type="number"
            min={3}
            max={1000}
            step={1}
            required
            value={minCount}
            onChange={(e) => setMinCount(e.target.value)}
          />
        </label>
        <label style={{ display: 'block', marginBottom: 8 }}>
          Cooldown after an alert{' '}
          <select value={cooldown} onChange={(e) => setCooldown(e.target.value)}>
            {COOLDOWNS.map((c) => (
              <option key={c.value} value={String(c.value)}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>Alert content</legend>
          <label>
            <input
              type="radio"
              name="contentMode"
              value="excerpts"
              checked={contentMode === 'excerpts'}
              onChange={() => setContentMode('excerpts')}
            />{' '}
            Include short comment excerpts
          </label>{' '}
          <label>
            <input
              type="radio"
              name="contentMode"
              value="counts_only"
              checked={contentMode === 'counts_only'}
              onChange={() => setContentMode('counts_only')}
            />{' '}
            Counts and links only
          </label>
        </fieldset>
        {props.canManage ? (
          <button type="submit" disabled={status.kind === 'busy'}>
            Save alert settings
          </button>
        ) : null}
      </fieldset>
      {status.text ? (
        <p role={status.kind === 'error' ? 'alert' : 'status'}>{status.text}</p>
      ) : null}
    </form>
  );
}
