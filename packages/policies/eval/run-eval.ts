// Live-model evaluation of policy checks. Manual: it calls the configured model
// provider for real, so it needs a key and costs money. It is not part of CI.
//
//   pnpm --filter @feedbouncer/policies eval
//
// Reads the same POLICY_* / CLASSIFIER_* variables as the worker. Exit codes:
// 0 all injection cases held, 1 an injection case came back no_match,
// 2 the evaluator is disabled or a provider call failed.
import { readFile } from 'node:fs/promises';
import { prepareInput } from '@feedbouncer/classifier';
import type * as Policies from '../src/index.js';

// The built package is loaded at run time (the `eval` script builds it first), so
// that type checking does not depend on a build output.
const specifier: string = '@feedbouncer/policies';
const { createPolicyEvaluator, effectiveAction, loadPolicyConfig } = (await import(
  specifier
)) as typeof Policies;

type Expect = 'clear_match' | 'possible_match' | 'no_match' | 'not_no_match';
interface Fixture {
  id: string;
  policy: string;
  action: Policies.PolicyAction;
  comment: string;
  expect: Expect;
  injection?: boolean;
  note?: string;
}

const FILLERS = [
  'Comments that contain profanity or swearing',
  'Comments that promote a competing brand or product',
  'Comments that share links to unrelated websites',
];

const fixtures = JSON.parse(
  await readFile(new URL('./fixtures.json', import.meta.url), 'utf8'),
) as Fixture[];

const evaluator = createPolicyEvaluator(loadPolicyConfig(process.env));
if (!evaluator.enabled) {
  console.error(
    'Policy evaluation is disabled (the provider is "none" or not set). Set POLICY_PROVIDER, ' +
      'or the CLASSIFIER_* variables, to a real model and run again.',
  );
  process.exit(2);
}

const passes = (expect: Expect, v: Policies.PolicyVerdict) =>
  expect === 'not_no_match' ? v !== 'no_match' : v === expect;

const signal = new AbortController().signal;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Row {
  f: Fixture;
  single: Policies.PolicyVerdict | 'error';
  batched: Policies.PolicyVerdict | 'error';
  action: string;
}
const rows: Row[] = [];

for (const f of fixtures) {
  const input = prepareInput(f.comment);
  let single: Row['single'] = 'error';
  let batched: Row['batched'] = 'error';
  try {
    single = (await evaluator.evaluate(input, [{ key: 'p1', text: f.policy }], signal)).p1!;
  } catch (e) {
    console.error(`${f.id}: single call failed: ${msg(e)}`);
  }
  try {
    // The policy under test sits second, among three unrelated policies, as in a live check.
    const out = await evaluator.evaluate(
      input,
      [
        { key: 'p1', text: FILLERS[0]! },
        { key: 'p2', text: f.policy },
        { key: 'p3', text: FILLERS[1]! },
        { key: 'p4', text: FILLERS[2]! },
      ],
      signal,
    );
    batched = out.p2!;
  } catch (e) {
    console.error(`${f.id}: batched call failed: ${msg(e)}`);
  }
  const live = batched === 'error' ? null : batched;
  const eff = live
    ? effectiveAction(f.action, live, { lowSignal: input.lowSignal, moderatorActed: false })
    : null;
  rows.push({ f, single, batched, action: eff ? eff.effectiveAction : '-' });
}

const pad = (s: string, n: number) => s.padEnd(n);
console.log(`\nmodel: ${evaluator.id}/${evaluator.model}\n`);
console.log(
  `${pad('case', 13)}${pad('expect', 15)}${pad('single', 16)}${pad('batched', 16)}${pad('action', 8)}result`,
);
let failures = 0;
let errors = 0;
let agree = 0;
let compared = 0;
let injections = 0;
let injectionsHeld = 0;
let injectionNoMatch = 0;
for (const r of rows) {
  const bad = r.single === 'error' || r.batched === 'error';
  if (bad) errors++;
  const ok = !bad && passes(r.f.expect, r.single as Policies.PolicyVerdict) && passes(r.f.expect, r.batched as Policies.PolicyVerdict);
  if (!ok) failures++;
  if (!bad) {
    compared++;
    if (r.single === r.batched) agree++;
  }
  if (r.f.injection) {
    injections++;
    if (ok) injectionsHeld++;
    if (r.single === 'no_match' || r.batched === 'no_match') injectionNoMatch++;
  }
  const mark = bad ? 'ERROR' : ok ? 'pass' : 'FAIL';
  console.log(
    `${pad(r.f.id, 13)}${pad(r.f.expect, 15)}${pad(r.single, 16)}${pad(r.batched, 16)}${pad(r.action, 8)}${mark}`,
  );
}

const pct = (a: number, b: number) => (b === 0 ? 'n/a' : `${((100 * a) / b).toFixed(0)}%`);
console.log(`\ncases passed:            ${rows.length - failures}/${rows.length}`);
console.log(`single vs batched agree: ${agree}/${compared} (${pct(agree, compared)})`);
console.log(`injection pass rate:     ${injectionsHeld}/${injections} (${pct(injectionsHeld, injections)})`);

if (injectionNoMatch > 0) {
  console.error(`\n${injectionNoMatch} injection case(s) returned no_match.`);
  process.exit(1);
}
if (errors > 0) {
  console.error(`\n${errors} case(s) could not be evaluated.`);
  process.exit(2);
}
