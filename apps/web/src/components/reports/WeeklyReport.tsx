import {
  NONE_QUALIFY,
  REPORT_HEADINGS,
  TOP_ADS_COLUMNS,
  TOP_ADS_EXPLAINER,
  type ReportView,
} from '@feedbouncer/reports/shared';
import { Card, CardContent } from '../ui/card';
import { StatCard, StatGrid } from '../ui/stat';
import { TableScroll } from '../states';

const SOURCE_NOTE = {
  snapshot: 'These are the numbers from the weekly email, as computed when the report was created.',
  live: 'Calculated from current data. No weekly email was created for this week.',
} as const;

/** processedLine reads e.g. "1,234 comments processed"; the stat tile wants the number alone. */
function leadingNumber(line: string): string {
  return /^[\d.,]+/.exec(line)?.[0] ?? line;
}

/** The weekly email's sections, from the same ReportView, so labels and rounding are identical. */
export function WeeklyReport({
  view,
  source,
}: {
  view: ReportView;
  source: keyof typeof SOURCE_NOTE;
}) {
  return (
    <>
      <div className="flex flex-col gap-1">
        <p className="font-semibold text-foreground">{view.range}</p>
        <p className="text-small text-dim">{SOURCE_NOTE[source]}</p>
        {view.incomplete ? <p role="note">{view.incomplete}</p> : null}
      </div>
      <StatGrid className="sm:grid-cols-2 lg:grid-cols-2">
        <StatCard
          label={REPORT_HEADINGS.processed}
          value={leadingNumber(view.processedLine)}
          note={view.changeLine}
        />
        <StatCard label={REPORT_HEADINGS.timeSaved} value={view.timeSaved} note={view.timeSavedNote} />
      </StatGrid>
      {view.categories ? (
        <section>
          <h2>{REPORT_HEADINGS.hidden}</h2>
          <Card>
            <CardContent className="flex flex-col gap-3">
              <ul className="flex flex-col gap-1.5">
                {view.categories.map((c) => (
                  <li key={c.label} className="flex items-baseline justify-between gap-3">
                    <span>{c.label}</span>
                    <span className="text-dim tabular-nums">{`${c.count} (${c.share})`}</span>
                  </li>
                ))}
              </ul>
              <p className="font-semibold text-foreground">{`Total hidden: ${view.totalHidden}`}</p>
            </CardContent>
          </Card>
        </section>
      ) : null}
      {view.topAds ? (
        <section>
          <h2>{REPORT_HEADINGS.topAds}</h2>
          {view.topAds === 'none_qualify' ? (
            <p data-state="empty">{NONE_QUALIFY}</p>
          ) : (
            <Card className="gap-3 py-(--fb-card-pad)">
              <CardContent className="px-0">
                <TableScroll className="rounded-none border-x-0 border-b-0">
                  <table>
                    <thead>
                      <tr>
                        {TOP_ADS_COLUMNS.map((c, i) => (
                          <th
                            key={c}
                            scope="col"
                            className={i < 2 ? undefined : 'text-end tabular-nums'}
                          >
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
                          <td className="text-end tabular-nums">{a.hidden}</td>
                          <td className="text-end tabular-nums">{a.total}</td>
                          <td className="text-end tabular-nums">{a.share}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroll>
              </CardContent>
              <p className="px-(--fb-card-pad) text-small text-dim">{TOP_ADS_EXPLAINER}</p>
            </Card>
          )}
        </section>
      ) : null}
      {view.brands ? (
        <section>
          <h2>{REPORT_HEADINGS.brands}</h2>
          <Card>
            <CardContent>
              <ul className="flex flex-col gap-1.5">
                {view.brands.map((b, i) => (
                  <li key={i} className="flex items-baseline justify-between gap-3">
                    <span>{b.name}</span>
                    <span className="text-dim tabular-nums">{`${b.processed} processed, ${b.hidden} hidden`}</span>
                  </li>
                ))}
                {view.brandsMore ? <li className="text-dim">{view.brandsMore}</li> : null}
              </ul>
            </CardContent>
          </Card>
        </section>
      ) : null}
    </>
  );
}
