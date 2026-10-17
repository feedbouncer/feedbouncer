const GUIDE = 'https://github.com/feedbouncer/feedbouncer/blob/main/docs/operations/alerts.md';

export function AlertsUnavailable() {
  return (
    <section>
      <p>Alerts aren&apos;t set up on this server.</p>
      <p>
        An administrator can enable Slack or email alerts by setting ALERT_CHANNELS. See the{' '}
        <a href={GUIDE}>self-hosting guide</a>.
      </p>
    </section>
  );
}
