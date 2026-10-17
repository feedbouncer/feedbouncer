import {
  NONE_QUALIFY,
  REPORT_HEADINGS,
  TOP_ADS_COLUMNS,
  TOP_ADS_EXPLAINER,
  type ReportView,
} from '@feedbouncer/reports/shared';

const SOURCE_NOTE = {
  snapshot: 'These are the numbers from the weekly email, as computed when the report was created.',
  live: 'Calculated from current data. No weekly email was created for this week.',
} as const;

const numeric = { textAlign: 'right' } as const;

/** The weekly email's sections, from the same ReportView, so labels and rounding are identical. */
export function WeeklyReport({
  view,
  source,
}: {
  view: ReportView;
  source: keyof typeof SOURCE_NOTE;
}) {
  return (
    <article>
      <p>{view.range}</p>
      <p>{SOURCE_NOTE[source]}</p>
      {view.incomplete ? <p role="note">{view.incomplete}</p> : null}
      <section>
        <h2>{REPORT_HEADINGS.processed}</h2>
        <p>
          <strong>{view.processedLine}</strong>
        </p>
        <p>{view.changeLine}</p>
      </section>
      {view.categories ? (
        <section>
          <h2>{REPORT_HEADINGS.hidden}</h2>
          <ul>
            {view.categories.map((c) => (
              <li key={c.label}>{`${c.label} — ${c.count} (${c.share})`}</li>
            ))}
          </ul>
          <p>
            <strong>{`Total hidden: ${view.totalHidden}`}</strong>
          </p>
        </section>
      ) : null}
      {view.topAds ? (
        <section>
          <h2>{REPORT_HEADINGS.topAds}</h2>
          {view.topAds === 'none_qualify' ? (
            <p>{NONE_QUALIFY}</p>
          ) : (
            <>
              <table>
                <thead>
                  <tr>
                    {TOP_ADS_COLUMNS.map((c, i) => (
                      <th key={c} scope="col" style={i < 2 ? undefined : numeric}>
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {view.topAds.map((a, i) => (
                    // Names can repeat, so rows are keyed by rank.
                    <tr key={i}>
                      <td>{a.archived ? `${a.ad} (archived)` : a.ad}</td>
                      <td>{a.platform}</td>
                      <td style={numeric}>{a.hidden}</td>
                      <td style={numeric}>{a.total}</td>
                      <td style={numeric}>{a.share}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p>{TOP_ADS_EXPLAINER}</p>
            </>
          )}
        </section>
      ) : null}
      <section>
        <h2>{REPORT_HEADINGS.timeSaved}</h2>
        <p>
          <strong>{view.timeSaved}</strong>
        </p>
        <p>{view.timeSavedNote}</p>
      </section>
      {view.brands ? (
        <section>
          <h2>{REPORT_HEADINGS.brands}</h2>
          <ul>
            {view.brands.map((b, i) => (
              <li key={i}>{`${b.name} — ${b.processed} processed, ${b.hidden} hidden`}</li>
            ))}
            {view.brandsMore ? <li>{view.brandsMore}</li> : null}
          </ul>
        </section>
      ) : null}
    </article>
  );
}
