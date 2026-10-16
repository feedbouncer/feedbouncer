'use client';
import { browserTimezone } from '../lib/timezone';
import { ApiForm } from './api-form';

/** The create-brand form for a server-rendered page: it sends the browser's timezone with the request. */
export function CreateBrandForm({ orgId }: { orgId: string }) {
  return (
    <ApiForm
      action={`/api/v1/orgs/${orgId}/brands`}
      fields={[{ name: 'name', label: 'Brand name', type: 'text' }]}
      submitLabel="Create brand"
      extraBody={() => ({ timezone: browserTimezone() })}
      refresh
    />
  );
}
