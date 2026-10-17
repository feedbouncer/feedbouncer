'use client';
import { ApiForm } from '../api-form';

export function AddSlackForm({ orgId }: { orgId: string }) {
  return (
    <ApiForm
      action={`/api/v1/orgs/${orgId}/alert-channels/slack`}
      fields={[
        { name: 'label', label: 'Name', type: 'text', autoComplete: 'off' },
        {
          name: 'webhookUrl',
          label: 'Incoming webhook URL',
          type: 'password',
          autoComplete: 'off',
        },
      ]}
      submitLabel="Connect Slack"
      resetOnSuccess
      refresh
    />
  );
}
