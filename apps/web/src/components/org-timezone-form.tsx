'use client';
import { useEffect, useState } from 'react';
import { browserTimezone } from '../lib/timezone';
import { ApiForm } from './api-form';

/** The workspace timezone, which sets when weekly reports are sent; suggests the viewer's zone until set. */
export function OrgTimezoneForm(props: { orgId: string; timezone: string; timezoneSet: boolean }) {
  // The zone list and the browser's zone are only known after hydration.
  const [zones, setZones] = useState([props.timezone]);
  const [suggested, setSuggested] = useState(props.timezone);
  useEffect(() => {
    const next = props.timezoneSet ? props.timezone : browserTimezone();
    setSuggested(next);
    setZones(
      [...new Set([...Intl.supportedValuesOf('timeZone'), 'UTC', props.timezone, next])].sort(),
    );
  }, [props.timezone, props.timezoneSet]);
  return (
    <ApiForm
      // Remounts once the suggestion is known, so the select shows it.
      key={suggested}
      action={`/api/v1/orgs/${props.orgId}`}
      method="PATCH"
      fields={[
        {
          name: 'timezone',
          label: `Workspace timezone${props.timezoneSet ? '' : ' (not set, using UTC)'}`,
          type: 'select',
          options: zones,
          defaultValue: suggested,
        },
      ]}
      submitLabel="Set timezone"
      successMessage="Timezone saved."
      refresh
    />
  );
}
