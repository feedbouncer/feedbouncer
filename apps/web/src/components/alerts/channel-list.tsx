import {
  channelName,
  errorCodeText,
  healthText,
  type AlertChannelDto,
  type Availability,
  type ChannelKind,
} from '../../lib/alerts';
import { ApiForm } from '../api-form';
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
    <li>
      <span>
        {channelName(c)}
        {c.hint ? ` (${c.hint})` : ''}
      </span>{' '}
      <strong>{healthText(c)}</strong>
      {canManage ? (
        <>
          {c.kind === 'email' &&
          (c.health === 'pending_confirmation' || c.health === 'unsubscribed') ? (
            <ApiForm
              action={`${base}/resend-confirmation`}
              fields={[]}
              submitLabel="Resend"
              successMessage="Confirmation sent."
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
          />
          <ApiForm action={base} method="DELETE" fields={[]} submitLabel="Remove" refresh />
        </>
      ) : null}
    </li>
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
        {rows.length === 0 ? <p>Nothing connected yet.</p> : null}
        <ul>
          {rows.map((c) => (
            <ChannelRow key={c.id} orgId={props.orgId} channel={c} canManage={props.canManage} />
          ))}
        </ul>
        {open && helper ? <p>{helper}</p> : null}
        {open && kind === 'slack' ? <AddSlackForm orgId={props.orgId} /> : null}
        {open && kind === 'email' ? <AddEmailForm orgId={props.orgId} /> : null}
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
