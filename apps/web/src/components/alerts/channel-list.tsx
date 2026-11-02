'use client';

import {
  channelName,
  errorCodeText,
  healthText,
  type AlertChannelDto,
  type Availability,
  type ChannelKind,
} from '../../lib/alerts';
import { ApiForm } from '../api-form';
import { Card, CardContent } from '../ui/card';
import { ListPanel, ListRow } from '../ui/list';
import { AddEmailForm } from './add-email-form';
import { AddSlackForm } from './add-slack-form';

function ChannelRow({
  orgId,
  channel: c,
  canManage,
}: {
  orgId: string;
  channel: AlertChannelDto;
  canManage: boolean;
}) {
  const base = `/api/v1/orgs/${orgId}/alert-channels/${c.id}` as const;
  return (
    <ListRow className="flex-col items-stretch sm:flex-row sm:items-center">
      <div className="flex flex-col gap-0.5">
        <span className="font-semibold text-foreground">
          {channelName(c)}
          {c.hint ? ` (${c.hint})` : ''}
        </span>
        <span className="text-small text-dim">{healthText(c)}</span>
      </div>
      {canManage ? (
        <div className="flex flex-wrap items-start gap-3">
          {c.kind === 'email' && c.health === 'pending_confirmation' ? (
            <ApiForm
              action={`${base}/resend-confirmation`}
              fields={[]}
              submitLabel="Resend"
              successMessage="Confirmation sent."
              size="sm"
            />
          ) : null}
          {c.health === 'disconnected' && c.kind === 'slack' ? (
            <ApiForm
              action={`${base}/slack`}
              method="PUT"
              fields={[
                {
                  name: 'webhookUrl',
                  label: 'Incoming webhook URL',
                  type: 'password',
                  autoComplete: 'off',
                },
              ]}
              submitLabel="Reconnect"
              resetOnSuccess
              refresh
              layout="inline"
              size="sm"
              className="w-64"
            />
          ) : null}
          <ApiForm
            action={`${base}/test`}
            fields={[]}
            submitLabel="Send test"
            successMessage={(body) => {
              const r = (body ?? {}) as { ok?: boolean; code?: string };
              return r.ok ? 'Test sent.' : `Test failed: ${errorCodeText(r.code ?? null)}`;
            }}
            refresh
            size="sm"
          />
          <ApiForm
            action={base}
            method="DELETE"
            fields={[]}
            submitLabel="Remove"
            variant="destructive"
            size="sm"
            refresh
          />
        </div>
      ) : null}
    </ListRow>
  );
}

export function ChannelList(props: {
  orgId: string;
  channels: AlertChannelDto[];
  availability: Availability;
  canManage: boolean;
}) {
  const section = (kind: ChannelKind, title: string, helper: string | null) => {
    const rows = props.channels.filter((c) => c.kind === kind);
    if (!props.availability[kind] && rows.length === 0) return null;
    const open = props.availability[kind] && props.canManage;
    return (
      <section>
        <h2>{title}</h2>
        {rows.length === 0 ? (
          <p data-state="empty">Nothing connected yet.</p>
        ) : (
          <ListPanel>
            {rows.map((c) => (
              <ChannelRow key={c.id} orgId={props.orgId} channel={c} canManage={props.canManage} />
            ))}
          </ListPanel>
        )}
        {open && (helper || kind === 'slack' || kind === 'email') ? (
          <Card>
            <CardContent className="flex flex-col gap-3">
              {helper ? <p className="text-small text-dim">{helper}</p> : null}
              {kind === 'slack' ? <AddSlackForm orgId={props.orgId} /> : null}
              {kind === 'email' ? <AddEmailForm orgId={props.orgId} /> : null}
            </CardContent>
          </Card>
        ) : null}
      </section>
    );
  };
  return (
    <>
      {section(
        'slack',
        'Slack channels',
        'Create an incoming webhook in Slack for the channel you want, then paste its URL here.',
      )}
      {section('email', 'Email recipients', null)}
    </>
  );
}
