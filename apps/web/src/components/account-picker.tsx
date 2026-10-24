'use client';
import Link from 'next/link';
import { useId, useState, type FormEvent } from 'react';
import {
  accountNotes,
  canConnect,
  connectRequest,
  connectResultText,
  isSelectable,
  nothingEligible,
  type PickerAccount,
  type ReviewModeChoiceState,
} from '../lib/accounts';
import { ApiRequestError, apiFetch } from '../lib/api-client';
import { messageFor } from '../lib/messages';
import { PLATFORM_COPY, type ConnectablePlatform } from '../lib/platforms';
import { ConnectButton } from './connect-button';

export type { PickerAccount } from '../lib/accounts';

interface ConnectResult {
  externalAccountId: string;
  status: string;
}

export function ReviewModeChoice(
  props: ReviewModeChoiceState & { onChange: (next: ReviewModeChoiceState) => void },
) {
  const id = useId();
  return (
    <fieldset>
      <label>
        <input
          type="checkbox"
          name="reviewMode"
          checked={props.on}
          onChange={(e) => props.onChange({ on: e.currentTarget.checked, acknowledged: false })}
        />{' '}
        Start in review mode (recommended)
      </label>
      {props.on ? null : (
        <>
          <p id={`${id}-notice`} role="note">
            Without review mode, your rules, the classifier and your policies start hiding,
            deleting, banning and replying as soon as this account is connected. A mistake in a rule
            can affect real people before you notice. We recommend keeping review mode on for the
            first 7 days.
          </p>
          <label>
            <input
              type="checkbox"
              name="acknowledgeRisk"
              required
              aria-describedby={`${id}-notice`}
              checked={props.acknowledged}
              onChange={(e) => props.onChange({ on: false, acknowledged: e.currentTarget.checked })}
            />{' '}
            I understand. Start automation now.
          </label>
        </>
      )}
    </fieldset>
  );
}

const SUBMIT_LABEL: Record<ConnectablePlatform, string> = {
  facebook: 'Connect selected Pages',
  instagram: 'Connect selected Instagram accounts',
  meta_ads: 'Connect selected ad accounts',
  tiktok: 'Connect TikTok account',
  tiktok_ads: 'Connect selected TikTok ad accounts',
};

export function AccountPicker(props: {
  orgId: string;
  brandId: string;
  platform: ConnectablePlatform;
  grantId: string;
  accounts: PickerAccount[];
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [results, setResults] = useState<ConnectResult[] | null>(null);
  const [reviewMode, setReviewMode] = useState<ReviewModeChoiceState>({
    on: true,
    acknowledged: false,
  });
  const copy = PLATFORM_COPY[props.platform];
  const connectionsHref = `/orgs/${props.orgId}/brands/${props.brandId}/connections`;
  const back = (
    <p>
      <Link href={connectionsHref}>Back to connections</Link>
    </p>
  );

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const accountIds = new FormData(e.currentTarget).getAll('accountId').map(String);
    if (accountIds.length === 0 || !canConnect(reviewMode)) return;
    setBusy(true);
    setError(null);
    try {
      const req = connectRequest(
        props.orgId,
        props.brandId,
        props.platform,
        props.grantId,
        accountIds,
        reviewMode,
      );
      const res = await apiFetch<{ results: ConnectResult[] }>(req.path, {
        method: 'POST',
        body: req.body,
      });
      setResults(res.results);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 404) setExpired(true);
      else
        setError(err instanceof ApiRequestError ? messageFor(err.code) : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  if (expired) {
    return (
      <>
        <p role="alert">This sign-in has expired. Connect again.</p>
        <ConnectButton
          orgId={props.orgId}
          brandId={props.brandId}
          platform={props.platform}
          label={copy.connectLabel}
        />
      </>
    );
  }

  if (results) {
    const names = new Map(props.accounts.map((a) => [a.externalAccountId, a.displayName]));
    return (
      <>
        <ul>
          {results.map((r) => (
            <li key={r.externalAccountId}>
              {`${names.get(r.externalAccountId) ?? r.externalAccountId}: ${connectResultText(r.status, props.platform)}`}
            </li>
          ))}
        </ul>
        {back}
      </>
    );
  }

  if (nothingEligible(props.accounts)) {
    return (
      <>
        <p role="status">{copy.noEligible}</p>
        <ul>
          {props.accounts.map((a) => (
            <li key={a.externalAccountId}>
              {`${a.displayName ?? 'Unnamed Page'} (${a.externalAccountId})`}{' '}
              <small>{accountNotes(a, props.platform).join('. ')}</small>
            </li>
          ))}
        </ul>
        {back}
      </>
    );
  }

  return (
    <form onSubmit={onSubmit}>
      <p>{copy.pickerIntro}</p>
      <ul>
        {props.accounts.map((a, i) => {
          const notes = accountNotes(a, props.platform);
          const noteId = `${id}-${i}-note`;
          return (
            <li key={a.externalAccountId}>
              <label>
                <input
                  type="checkbox"
                  name="accountId"
                  value={a.externalAccountId}
                  disabled={!isSelectable(a)}
                  aria-describedby={notes.length > 0 ? noteId : undefined}
                />{' '}
                {`${a.displayName ?? 'Unnamed Page'} (${a.externalAccountId})`}
              </label>
              {notes.length > 0 ? (
                <>
                  {' '}
                  <small id={noteId}>{notes.join('. ')}</small>
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
      <ReviewModeChoice {...reviewMode} onChange={setReviewMode} />
      <button type="submit" disabled={busy || !canConnect(reviewMode)}>
        {SUBMIT_LABEL[props.platform]}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  );
}
