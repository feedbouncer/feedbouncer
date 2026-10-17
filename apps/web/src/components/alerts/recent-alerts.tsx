import { alertTypeLabel, errorCodeText, type AlertEventDto } from '../../lib/alerts';
import { LocalTime } from '../local-time';

function countsText(e: AlertEventDto): string {
  const { negatives, total, items } = e.counts;
  if (negatives !== undefined) return `${negatives} of ${total ?? 0} comments negative`;
  if (items !== undefined) return `${items} flagged`;
  return '';
}

export function RecentAlerts({
  events,
  channelLabels,
}: {
  events: AlertEventDto[];
  channelLabels: Record<string, string>;
}) {
  return (
    <section>
      <h2>Recent alerts</h2>
      {events.length === 0 ? <p>No alerts yet.</p> : null}
      <ul>
        {events.map((e) => (
          <li key={e.id}>
            <strong>{alertTypeLabel(e.type)}</strong> <LocalTime iso={e.createdAt} />
            {countsText(e) ? ` - ${countsText(e)}` : ''}
            {e.explanation ? (
              <div>
                {`Why: ${e.counts.negatives ?? 0} negative vs. usual ${Number(e.explanation.expectedPerHour.toFixed(1))}/hour at ${e.explanation.sensitivity} sensitivity`}
              </div>
            ) : null}
            {e.deliveries.length > 0 ? (
              <ul>
                {e.deliveries.map((d) => (
                  <li key={d.channelId}>
                    {`${Object.hasOwn(channelLabels, d.channelId) ? channelLabels[d.channelId] : 'Removed channel'}: ${d.state}`}
                    {d.lastErrorCode ? ` - ${errorCodeText(d.lastErrorCode)}` : ''}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
