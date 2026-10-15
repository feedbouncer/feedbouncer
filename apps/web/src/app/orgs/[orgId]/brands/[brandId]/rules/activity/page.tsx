import Link from 'next/link';
import { notFound } from 'next/navigation';
import { decisionText } from '../../../../../../../components/rules/decision-badge';
import {
  CATEGORIES,
  CATEGORY_LABEL,
  classifierEvidence,
} from '../../../../../../../lib/classifier';
import { formatUtc } from '../../../../../../../lib/format';
import { isUuid } from '../../../../../../../lib/ids';
import {
  ACTION_LABEL,
  KIND_LABEL,
  RULE_ACTIONS,
  RULE_KINDS,
  type ActivityView,
  type RuleView,
} from '../../../../../../../lib/rules';
import { dataOrThrow, requireMe, serverGet } from '../../../../../../../lib/server-api';

const CURSOR = /^[1-9][0-9]{0,17}$/;
const MODES = ['enforce', 'suggest'] as const;
const SOURCES = ['rule', 'classifier'] as const;

const one = (v: string | string[] | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined;

export default async function RuleActivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; brandId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId, brandId } = await params;
  if (!isUuid(orgId) || !isUuid(brandId)) notFound();
  await requireMe(`/orgs/${orgId}/brands/${brandId}/rules/activity`);
  const sp = await searchParams;
  const ruleId = isUuid(sp.ruleId) ? sp.ruleId : undefined;
  const kind = RULE_KINDS.find((k) => k === sp.kind);
  const outcome = RULE_ACTIONS.find((a) => a === sp.outcome);
  const mode = MODES.find((m) => m === sp.mode);
  const source = SOURCES.find((x) => x === sp.source);
  const category = CATEGORIES.find((c) => c === sp.category);
  const cursor = one(sp.cursor);
  const filters = new URLSearchParams();
  if (ruleId) filters.set('ruleId', ruleId);
  if (kind) filters.set('kind', kind);
  if (outcome) filters.set('outcome', outcome);
  if (mode) filters.set('mode', mode);
  if (source) filters.set('source', source);
  if (category) filters.set('category', category);
  const query = new URLSearchParams(filters);
  query.set('limit', '50');
  if (cursor && CURSOR.test(cursor)) query.set('before', cursor);

  const base = `/api/v1/orgs/${orgId}/brands/${brandId}` as const;
  const { items, nextCursor } = dataOrThrow(
    await serverGet<{ items: ActivityView[]; nextCursor: string | null }>(
      `${base}/rule-activity?${query.toString()}`,
    ),
    'rule activity',
  );
  const { rules } = dataOrThrow(await serverGet<{ rules: RuleView[] }>(`${base}/rules`), 'rules');
  const page = `/orgs/${orgId}/brands/${brandId}/rules/activity`;
  const more = new URLSearchParams(filters);
  if (nextCursor) more.set('cursor', nextCursor);
  return (
    <main>
      <h1>Rule activity</h1>
      <form method="get">
        <label>
          Rule{' '}
          <select name="ruleId" defaultValue={ruleId ?? ''}>
            <option value="">All</option>
            {rules.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>{' '}
        <label>
          Type{' '}
          <select name="kind" defaultValue={kind ?? ''}>
            <option value="">All</option>
            {RULE_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>{' '}
        <label>
          Outcome{' '}
          <select name="outcome" defaultValue={outcome ?? ''}>
            <option value="">All</option>
            {RULE_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {ACTION_LABEL[a]}
              </option>
            ))}
          </select>
        </label>{' '}
        <label>
          Mode{' '}
          <select name="mode" defaultValue={mode ?? ''}>
            <option value="">All</option>
            <option value="enforce">Enforced</option>
            <option value="suggest">Dry run</option>
          </select>
        </label>{' '}
        <label>
          Source{' '}
          <select name="source" defaultValue={source ?? ''}>
            <option value="">All</option>
            <option value="rule">Rules</option>
            <option value="classifier">Classifier</option>
          </select>
        </label>{' '}
        <label>
          Category{' '}
          <select name="category" defaultValue={category ?? ''}>
            <option value="">All</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </label>{' '}
        <button type="submit">Filter</button>
      </form>
      {items.length === 0 ? <p>No rule activity yet.</p> : null}
      {items.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Comment</th>
              <th scope="col">Source</th>
              <th scope="col">Evidence</th>
              <th scope="col">Outcome</th>
              <th scope="col">Mode</th>
              <th scope="col">Reason</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {items.map((d) => (
              <tr key={d.id}>
                <td>{formatUtc(d.createdAt)}</td>
                <td>
                  <Link href={`/orgs/${orgId}/brands/${brandId}/comments#comment-${d.commentId}`}>
                    {d.commentExcerpt}
                  </Link>
                </td>
                <td>
                  {d.actorType === 'classifier'
                    ? 'Classifier'
                    : d.rule
                      ? d.rule.name
                      : 'Unknown rule'}
                </td>
                <td>
                  {d.classifier
                    ? classifierEvidence(d.classifier)
                    : d.rule?.kind
                      ? KIND_LABEL[d.rule.kind]
                      : ''}
                </td>
                <td>{ACTION_LABEL[d.outcome]}</td>
                <td>{d.mode === 'suggest' ? 'Dry run' : 'Enforced'}</td>
                <td>{d.reason}</td>
                <td>{d.fallback ? decisionText(d) : (d.action?.status ?? '')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {nextCursor ? (
        <p>
          <Link href={`${page}?${more.toString()}`}>Load more</Link>
        </p>
      ) : null}
      <p>
        <Link href={`/orgs/${orgId}/brands/${brandId}/rules`}>Back to rules</Link>
      </p>
    </main>
  );
}
