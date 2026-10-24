'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';
import {
  readySteps,
  savedWarnings,
  warningText,
  type ActionCapabilitiesDto,
  type DraftStep,
  type StepWarningDto,
} from '../../lib/actions';
import { ApiRequestError, apiFetch } from '../../lib/api-client';
import { messageFor } from '../../lib/messages';
import { StepEditor } from '../actions/step-editor';
import {
  APPLIES_TO_LABEL,
  KIND_LABEL,
  RULE_APPLIES_TO,
  RULE_KINDS,
  RULE_PLATFORMS,
  emptyForm,
  formFromConditions,
  ruleRequestBody,
  type RuleAppliesTo,
  type RuleFormState,
  type RuleIssue,
  type RuleKind,
  type RuleView,
} from '../../lib/rules';

// The condition field each editor control writes, as the API names it in issue paths.
const FIELD_KEYS: Record<RuleKind, string[]> = {
  keyword: ['terms', 'match'],
  regex: ['patterns'],
  link_domain: ['mode', 'domains'],
  emoji: ['emoji', 'maxCount'],
  author: ['list', 'platform', 'entries'],
  competitor: ['names', 'handles', 'domains'],
};

// A problem with one step, as the API names it: actions.<index>[.field].
const STEP_PATH = /^actions\.\d/;

function issuesAt(issues: RuleIssue[], key: string): RuleIssue[] {
  return issues.filter((i) => i.path.split('.')[1] === key && i.path.startsWith('conditions.'));
}

function issueText(i: RuleIssue): string {
  const index = i.path.split('.')[2];
  return index !== undefined && /^\d+$/.test(index)
    ? `Entry ${Number(index) + 1}: ${i.message}`
    : i.message;
}

function Problems({ issues }: { issues: RuleIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul role="alert">
      {issues.map((i, n) => (
        <li key={n}>{issueText(i)}</li>
      ))}
    </ul>
  );
}

function Field(props: { label: string; issues: RuleIssue[]; hint?: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: 'block' }}>
        {props.label} {props.children}
      </label>
      {props.hint ? <small>{props.hint}</small> : null}
      <Problems issues={props.issues} />
    </div>
  );
}

/** Shown after a save the API accepted with warnings, instead of leaving the page. */
export function SaveWarnings(props: {
  warnings: StepWarningDto[];
  rulesHref: string;
  ruleHref: string;
}) {
  return (
    <section role="status">
      <p>Rule saved. Some steps will not run everywhere:</p>
      <ul>
        {props.warnings.map((w, n) => (
          <li key={n}>{warningText(w)}</li>
        ))}
      </ul>
      <p>
        <Link href={props.ruleHref}>Edit the rule</Link> ·{' '}
        <Link href={props.rulesHref}>Back to rules</Link>
      </p>
    </section>
  );
}

export function RuleEditor(props: {
  orgId: string;
  brandId: string;
  rule?: RuleView;
  capabilities: ActionCapabilitiesDto;
  initialIssues?: RuleIssue[];
}) {
  const router = useRouter();
  const { rule } = props;
  const [name, setName] = useState(rule?.name ?? '');
  const [kind, setKind] = useState<RuleKind>(rule?.kind ?? 'keyword');
  const [form, setForm] = useState<RuleFormState>(() =>
    rule ? formFromConditions(rule.conditions) : emptyForm(),
  );
  const [steps, setSteps] = useState<DraftStep[]>(rule?.actions ?? [{ type: 'flag_for_review' }]);
  const [dryRun, setDryRun] = useState(rule ? rule.mode === 'suggest' : true);
  const [appliesTo, setAppliesTo] = useState<RuleAppliesTo>(rule?.appliesTo ?? 'all');
  const [issues, setIssues] = useState<RuleIssue[]>(props.initialIssues ?? []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<{ id: string; warnings: StepWarningDto[] } | null>(null);

  // Allow and trusted author lists let comments through, so they take no steps.
  const allowList = kind === 'author' && form.authorList !== 'block';
  const set = <K extends keyof RuleFormState>(key: K, value: RuleFormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const at = (key: string) => issuesAt(issues, key);
  const known = FIELD_KEYS[kind];
  const general = issues.filter(
    (i) =>
      !(i.path.startsWith('conditions.') && known.includes(i.path.split('.')[1] ?? '')) &&
      !STEP_PATH.test(i.path),
  );

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const actions = allowList ? [] : readySteps(steps);
    if (actions === null) {
      setError('Tick the confirmation box of each Delete or Ban step.');
      return;
    }
    setBusy(true);
    setError(null);
    setIssues([]);
    const body = ruleRequestBody({ name, kind, form, actions, dryRun, appliesTo });
    const base = `/api/v1/orgs/${props.orgId}/brands/${props.brandId}/rules` as const;
    type Saved = { id: string; actionWarnings?: StepWarningDto[] };
    try {
      const res = rule
        ? await apiFetch<Saved>(`${base}/${rule.id}`, { method: 'PATCH', body })
        : await apiFetch<Saved>(base, { method: 'POST', body });
      const warnings = savedWarnings(res);
      // A step that lacks a permission still saves: say so before leaving the editor.
      if (warnings.length > 0) {
        setSaved({ id: res.id, warnings });
        router.refresh();
        return;
      }
      router.push(`/orgs/${props.orgId}/brands/${props.brandId}/rules`);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setIssues(err.issues);
        setError(messageFor(err.code));
      } else setError('Something went wrong.');
      setBusy(false);
    }
  }

  const rulesHref = `/orgs/${props.orgId}/brands/${props.brandId}/rules`;
  if (saved)
    return (
      <SaveWarnings
        warnings={saved.warnings}
        rulesHref={rulesHref}
        ruleHref={`${rulesHref}/${saved.id}`}
      />
    );

  return (
    <form onSubmit={onSubmit}>
      {error ? <p role="alert">{error}</p> : null}
      <Problems issues={general} />
      <Field label="Name" issues={[]}>
        <input
          name="name"
          required
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field label="Type" issues={[]}>
        <select name="kind" value={kind} onChange={(e) => setKind(e.target.value as RuleKind)}>
          {RULE_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Applies to" issues={[]}>
        <select
          name="appliesTo"
          value={appliesTo}
          onChange={(e) => setAppliesTo(e.target.value as RuleAppliesTo)}
        >
          {RULE_APPLIES_TO.map((a) => (
            <option key={a} value={a}>
              {APPLIES_TO_LABEL[a]}
            </option>
          ))}
        </select>
      </Field>

      {kind === 'keyword' ? (
        <>
          <Field label="Words and phrases, one per line" issues={at('terms')}>
            <textarea
              name="terms"
              rows={6}
              value={form.keywordTerms}
              onChange={(e) => set('keywordTerms', e.target.value)}
            />
          </Field>
          <fieldset>
            <legend>Match</legend>
            <label>
              <input
                type="radio"
                name="match"
                checked={form.keywordMatch === 'whole_word'}
                onChange={() => set('keywordMatch', 'whole_word')}
              />{' '}
              Whole words
            </label>{' '}
            <label>
              <input
                type="radio"
                name="match"
                checked={form.keywordMatch === 'contains'}
                onChange={() => set('keywordMatch', 'contains')}
              />{' '}
              Anywhere in a word
            </label>
          </fieldset>
        </>
      ) : null}

      {kind === 'regex' ? (
        <Field
          label="Patterns, one per line"
          issues={at('patterns')}
          hint="Patterns run on lower-cased, accent-free text. RE2 syntax; look-around is not supported."
        >
          <textarea
            name="patterns"
            rows={6}
            value={form.regexPatterns}
            onChange={(e) => set('regexPatterns', e.target.value)}
          />
        </Field>
      ) : null}

      {kind === 'link_domain' ? (
        <>
          <fieldset>
            <legend>Links</legend>
            <label>
              <input
                type="radio"
                name="linkMode"
                checked={form.linkMode === 'blocklist'}
                onChange={() => set('linkMode', 'blocklist')}
              />{' '}
              Match links to these domains
            </label>{' '}
            <label>
              <input
                type="radio"
                name="linkMode"
                checked={form.linkMode === 'allowlist'}
                onChange={() => set('linkMode', 'allowlist')}
              />{' '}
              Match links to any other domain
            </label>
          </fieldset>
          <Field label="Domains, one per line" issues={at('domains')}>
            <textarea
              name="domains"
              rows={6}
              value={form.linkDomains}
              onChange={(e) => set('linkDomains', e.target.value)}
            />
          </Field>
          <label style={{ display: 'block' }}>
            <input
              type="checkbox"
              name="exemptOwnDomains"
              checked={form.exemptOwnDomains}
              onChange={(e) => set('exemptOwnDomains', e.target.checked)}
            />{' '}
            Never match your own domains
          </label>
          <label style={{ display: 'block' }}>
            <input
              type="checkbox"
              name="matchShorteners"
              checked={form.matchShorteners}
              onChange={(e) => set('matchShorteners', e.target.checked)}
            />{' '}
            Match link shorteners
          </label>
          <label style={{ display: 'block' }}>
            <input
              type="checkbox"
              name="matchLookalikes"
              checked={form.matchLookalikes}
              onChange={(e) => set('matchLookalikes', e.target.checked)}
            />{' '}
            Match look-alike domains
          </label>
        </>
      ) : null}

      {kind === 'emoji' ? (
        <>
          <Field label="Emoji, separated by spaces" issues={at('emoji')}>
            <textarea
              name="emoji"
              rows={3}
              value={form.emojiList}
              onChange={(e) => set('emojiList', e.target.value)}
            />
          </Field>
          <Field label="Maximum emoji per comment (optional)" issues={at('maxCount')}>
            <input
              name="maxCount"
              type="number"
              min={0}
              max={500}
              value={form.emojiMaxCount}
              onChange={(e) => set('emojiMaxCount', e.target.value)}
            />
          </Field>
        </>
      ) : null}

      {kind === 'author' ? (
        <>
          <Field label="List type" issues={at('list')}>
            <select
              name="list"
              value={form.authorList}
              onChange={(e) => set('authorList', e.target.value as RuleFormState['authorList'])}
            >
              <option value="block">Block list</option>
              <option value="allow">Allow list</option>
              <option value="trusted">Trusted authors</option>
            </select>
          </Field>
          <Field label="Platform" issues={at('platform')}>
            <select
              name="platform"
              value={form.authorPlatform}
              onChange={(e) => set('authorPlatform', e.target.value)}
            >
              {RULE_PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Authors, one per line"
            issues={at('entries')}
            hint="Write id:12345, @handle, or both. Allow and trusted lists need the ID."
          >
            <textarea
              name="entries"
              rows={6}
              value={form.authorEntries}
              onChange={(e) => set('authorEntries', e.target.value)}
            />
          </Field>
        </>
      ) : null}

      {kind === 'competitor' ? (
        <>
          <Field label="Names, one per line" issues={at('names')}>
            <textarea
              name="names"
              rows={4}
              value={form.competitorNames}
              onChange={(e) => set('competitorNames', e.target.value)}
            />
          </Field>
          <Field label="Handles, one per line" issues={at('handles')}>
            <textarea
              name="handles"
              rows={4}
              value={form.competitorHandles}
              onChange={(e) => set('competitorHandles', e.target.value)}
            />
          </Field>
          <Field label="Domains, one per line" issues={at('domains')}>
            <textarea
              name="domains"
              rows={4}
              value={form.competitorDomains}
              onChange={(e) => set('competitorDomains', e.target.value)}
            />
          </Field>
        </>
      ) : null}

      {allowList ? (
        <p role="note">Comments from these authors are always allowed, so no steps apply.</p>
      ) : (
        <StepEditor
          value={steps}
          onChange={setSteps}
          capabilities={props.capabilities}
          issues={issues}
          {...(kind === 'author' && { onlyPlatform: form.authorPlatform })}
        />
      )}
      <label style={{ display: 'block', marginBottom: 12 }}>
        <input
          type="checkbox"
          name="dryRun"
          checked={dryRun}
          onChange={(e) => setDryRun(e.target.checked)}
        />{' '}
        Dry run (log matches only)
      </label>
      <button type="submit" disabled={busy}>
        {rule ? 'Save rule' : 'Create rule'}
      </button>
    </form>
  );
}
