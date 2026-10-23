import type { ScanFailure, ScanResultV1 } from '@feedbouncer/scan/contract';
import { CATEGORY_LABEL, NOTICE_COPY, TAG_LABEL, errorCopy } from './copy';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const pct = (n: number) => `${Number(n.toFixed(1))}%`;

// Comment text and author labels are untrusted: they are only ever React text children.
export function ResultView({
  result,
  pageName,
  mode,
}: {
  result: ScanResultV1;
  pageName: string;
  mode: 'owner' | 'shared';
}) {
  const { totals } = result;
  const hasShare = !result.empty && result.sharePct !== null;
  const ads = totals.adsCovered === 1 ? 'ad' : `${totals.adsCovered} ads`;
  return (
    <>
      <h1>{pageName}</h1>
      <h2>
        {hasShare
          ? `${pct(result.sharePct ?? 0)} of comments on your last ${ads} look like scam or spam`
          : result.empty
            ? 'Nothing to scan yet: we found no comments on your recent ads in the last 30 days.'
            : `We read ${plural(totals.commentsScanned, 'comment', 'comments')} on your recent ads, but none could be assessed.`}
      </h2>
      {hasShare ? (
        <p>
          Based on {plural(totals.commentsScanned, 'comment', 'comments')} on{' '}
          {plural(totals.adsCovered, 'ad', 'ads')}
          {result.reliable ? null : '. Not enough comments for a reliable share.'}
        </p>
      ) : null}
      {result.notices.length > 0 ? (
        <ul>
          {result.notices.map((n) => (
            <li key={n}>{NOTICE_COPY[n]}</li>
          ))}
        </ul>
      ) : null}
      {hasShare ? <Details result={result} mode={mode} /> : null}
      <p>
        This is an estimate from an automated classifier, not a verdict. It can be wrong in both
        directions.
      </p>
      <p>
        {mode === 'owner'
          ? 'We keep this result for 30 days. You can delete it now.'
          : 'We keep this result for 30 days.'}
      </p>
      <p>
        <a href="/api/v1/scan/cta">FeedBouncer can hide comments like these automatically</a>
      </p>
    </>
  );
}

function Details({ result, mode }: { result: ScanResultV1; mode: 'owner' | 'shared' }) {
  const { totals } = result;
  return (
    <>
      <h3>Breakdown</h3>
      <ul>
        {result.breakdown.map((b) => (
          <li key={b.category}>
            {CATEGORY_LABEL[b.category]}: {b.count}
            <ul>
              {Object.entries(b.tags).map(([tag, n]) => (
                <li key={tag}>
                  {TAG_LABEL[tag as keyof typeof TAG_LABEL] ?? 'Other'}: {n}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <p>
        Uncertain: {totals.uncertain} · Could not be classified: {totals.unclassified} · Already
        hidden, not counted: {totals.hiddenExcluded}
      </p>
      <h3>By ad</h3>
      <table>
        <thead>
          <tr>
            <th>Ad</th>
            <th>Platform</th>
            <th>Comments</th>
            <th>Scam or spam</th>
            <th>Uncertain</th>
          </tr>
        </thead>
        <tbody>
          {result.perAd.map((a) => (
            <tr key={a.ordinal}>
              <td>{mode === 'shared' || !a.label ? `Ad ${a.ordinal}` : a.label}</td>
              <td>{a.platform === 'instagram' ? 'Instagram' : 'Facebook'}</td>
              <td>{a.scanned}</td>
              <td>{a.scamSpam}</td>
              <td>{a.uncertain}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {result.examples.length > 0 ? <h3>Examples</h3> : null}
      <ul>
        {result.examples.map((e, i) => (
          <li key={i}>
            {mode === 'owner' ? (
              <>
                <strong>{e.authorLabel}</strong> on Ad {e.adOrdinal}
              </>
            ) : (
              `On Ad ${e.adOrdinal}`
            )}
            {e.repeatCount > 1 ? ` (posted ×${e.repeatCount})` : null}
            <blockquote>{e.text}</blockquote>
            <small>{e.reason}</small>
          </li>
        ))}
      </ul>
    </>
  );
}

export function FailedView({ failureReason }: { failureReason: ScanFailure | null }) {
  return (
    <>
      <h1>The scan did not finish</h1>
      <p role="alert">{errorCopy(failureReason) ?? errorCopy('internal')}</p>
      <p>
        <a href="/scan">Retry</a>
      </p>
    </>
  );
}
