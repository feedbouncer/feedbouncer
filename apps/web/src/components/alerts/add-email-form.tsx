'use client';
import { ApiForm } from '../api-form';

export function AddEmailForm({ orgId }: { orgId: string }) {
  return (
    <ApiForm
      action={`/api/v1/orgs/${orgId}/alert-channels/email`}
      fields={[{ name: 'email', label: 'Email address', type: 'email', autoComplete: 'off' }]}
      submitLabel="Add recipient"
      successMessage="Added. A confirmation email was sent."
      resetOnSuccess
      refresh
    />
  );
}
