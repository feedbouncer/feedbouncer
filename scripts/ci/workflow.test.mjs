// Guards CI invariants that branch protection and fork-PR safety depend on.
// If a change here is intentional (e.g. renaming a check), update branch
// protection in the same PR. Renamed checks silently stop being required.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { parse } from 'yaml';

const read = (rel) => readFile(new URL(`../../${rel}`, import.meta.url), 'utf8');
const workflowText = await read('.github/workflows/ci.yml');
const actionText = await read('.github/actions/setup/action.yml');
const docsCheck = parse(await read('.github/actions/docs-check/action.yml'));
const workflow = parse(workflowText);
const action = parse(actionText);
const jobs = Object.entries(workflow.jobs);
const pkg = JSON.parse(await read('package.json'));

function allSteps() {
  return [...jobs.flatMap(([, job]) => job.steps ?? []), ...action.runs.steps];
}

test('required check names are stable', () => {
  assert.equal(workflow.jobs.typecheck?.name, 'Typecheck');
  assert.equal(workflow.jobs.test?.name, 'Test');
  assert.equal(workflow.jobs['docker-build']?.name, 'Docker build');
  assert.equal(workflow.jobs['db-migrations']?.name, 'Database migrations');
});

test('triggers: pull_request and push to main only, no path filters', () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'push']);
  assert.deepEqual(workflow.on.push.branches, ['main']);
  for (const trigger of Object.values(workflow.on)) {
    assert.ok(
      !trigger?.paths && !trigger?.['paths-ignore'],
      'path filters would leave required checks pending',
    );
  }
});

test('least-privilege token: contents read, never widened per job', () => {
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  for (const [id, job] of jobs) {
    for (const level of Object.values(job.permissions ?? {})) {
      assert.ok(['read', 'none'].includes(level), `job ${id} widens permissions`);
    }
  }
});

test('no secrets are referenced (fork PRs must work)', () => {
  assert.doesNotMatch(workflowText, /secrets\s*[.[]/);
  assert.doesNotMatch(actionText, /secrets\s*[.[]/);
});

test('every job has a timeout', () => {
  for (const [id, job] of jobs) {
    assert.equal(typeof job['timeout-minutes'], 'number', `job ${id} has no timeout-minutes`);
  }
});

test('superseded PR runs are cancelled, main runs are not', () => {
  // Each main push needs its own group: GitHub keeps one pending run per group.
  const group = String(workflow.concurrency.group);
  assert.match(group, /github\.event\.pull_request\.number/);
  assert.match(group, /github\.sha/);
  assert.equal(
    workflow.concurrency['cancel-in-progress'],
    "${{ github.event_name == 'pull_request' }}",
  );
});

test('third-party actions are pinned to full commit SHAs', () => {
  for (const step of allSteps()) {
    if (!step.uses || step.uses.startsWith('./')) continue;
    assert.match(
      step.uses,
      /^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/,
      `unpinned action: ${step.uses}`,
    );
  }
  // YAML parsing drops comments, so check the raw lines for the version tag.
  for (const text of [workflowText, actionText]) {
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/);
      if (!m || m[1].startsWith('./')) continue;
      assert.match(m[2], /^\s+#\s*v\d+/, `missing "# v<version>" comment: ${line.trim()}`);
    }
  }
});

test('no ${{ }} expressions inside run scripts (script-injection guard)', () => {
  for (const step of allSteps()) {
    if (step.run)
      assert.doesNotMatch(step.run, /\$\{\{/, `expression in run: ${step.name ?? step.run}`);
  }
});

test('checkout never persists credentials', () => {
  for (const step of allSteps()) {
    if (step.uses?.startsWith('actions/checkout@')) {
      assert.equal(step.with?.['persist-credentials'], false);
    }
  }
});

test('images are built from a local repo-root context and never pushed', () => {
  const build = workflow.jobs['docker-image'].steps.find((s) =>
    s.uses?.startsWith('docker/build-push-action@'),
  );
  assert.equal(build.with.context, '.');
  assert.equal(build.with.outputs, 'type=cacheonly');
  assert.ok(!('push' in build.with) || build.with.push === false);
});

test('installs use the frozen lockfile', () => {
  assert.ok(action.runs.steps.some((s) => s.run?.includes('pnpm install --frozen-lockfile')));
});

test('compose checks exist with stable names', () => {
  assert.equal(workflow.jobs['compose-config']?.name, 'Compose config');
  assert.equal(workflow.jobs['compose-smoke']?.name, 'Compose smoke');
});

test('compose smoke always tears the stack down', () => {
  const last = workflow.jobs['compose-smoke'].steps.at(-1);
  assert.equal(last.if, 'always()');
  assert.match(last.run, /docker compose down -v/);
});

test('compose smoke owns a dedicated project and tests the base file only', () => {
  const job = workflow.jobs['compose-smoke'];
  assert.match(String(job.env?.COMPOSE_PROJECT_NAME), /smoke/);
  assert.ok(!job.env?.COMPOSE_FILE, 'job-level overlay would hide published-port regressions');
  const smoke = job.steps.find((s) => s.run?.includes('scripts/dev-stack/smoke.mjs'));
  assert.ok(smoke, 'smoke step exists');
  assert.ok(!smoke.env?.COMPOSE_FILE);
  const last = job.steps.at(-1);
  assert.equal(last.env?.COMPOSE_ENV_FILES, '.env.example', 'teardown must not need .env');
});

test('database migrations check runs on a fresh Postgres 17 service with a stable name', () => {
  const job = workflow.jobs['db-migrations'];
  assert.equal(job?.name, 'Database migrations');
  assert.equal(job.services?.postgres?.image, 'postgres:17-alpine');
  assert.match(String(job.services.postgres.env?.POSTGRES_PASSWORD), /^dev-only-/);
  const runs = job.steps.map((s) => s.run ?? '').join('\n');
  assert.match(runs, /migrate:deploy[\s\S]*migrate:deploy/, 'applies twice (idempotency)');
  assert.match(
    runs,
    /migrate:down --yes-destroy-data[\s\S]*migrate:deploy/,
    'rolls back and re-applies',
  );
  assert.match(runs, /test:integration/);
});

test('API integration runs against Postgres 17 and Redis services with a stable name', () => {
  const job = workflow.jobs['api-integration'];
  assert.equal(job?.name, 'API integration');
  assert.equal(job.services?.postgres?.image, 'postgres:17-alpine');
  assert.match(String(job.services.postgres.env?.POSTGRES_PASSWORD), /^dev-only-/);
  assert.match(String(job.services?.redis?.image), /^redis:/);
  assert.match(String(job.env?.REDIS_URL), /^redis:\/\/127\.0\.0\.1:/);
  const runs = job.steps.map((s) => s.run ?? '').join('\n');
  assert.match(runs, /@feedbouncer\/api test:integration/);
});

test('compose smoke runs the auth smoke after the lifecycle smoke and before teardown', () => {
  const steps = workflow.jobs['compose-smoke'].steps;
  const at = (needle) => steps.findIndex((s) => s.run?.includes(needle));
  const lifecycle = at('scripts/dev-stack/smoke.mjs');
  const auth = at('pnpm stack:auth-smoke');
  assert.ok(lifecycle >= 0 && auth > lifecycle, 'auth smoke runs after the lifecycle smoke');
  assert.ok(auth < steps.length - 1, 'auth smoke runs before teardown');
  assert.ok(!steps[auth].env?.COMPOSE_FILE);
  assert.equal(pkg.scripts['stack:auth-smoke'], 'node scripts/dev-stack/auth-smoke.mjs');
});

const docsDeployText = await read('.github/workflows/docs-deploy.yml');
const docsDeploy = parse(docsDeployText);
const deployJobs = Object.entries(docsDeploy.jobs);
const deploySteps = deployJobs.flatMap(([, job]) => job.steps ?? []);

test('docs-deploy.yml triggers only on push to main', () => {
  assert.deepEqual(Object.keys(docsDeploy.on), ['push']);
  assert.deepEqual(docsDeploy.on.push.branches, ['main']);
  assert.ok(!docsDeploy.on.push.paths && !docsDeploy.on.push['paths-ignore']);
  assert.deepEqual(docsDeploy.permissions, { contents: 'read' });
  assert.deepEqual(docsDeploy.concurrency, { group: 'pages', 'cancel-in-progress': false });
});

test('only the deploy job may write pages or id-token', () => {
  for (const [id, job] of deployJobs) {
    if (id === 'deploy') {
      assert.deepEqual(job.permissions, { pages: 'write', 'id-token': 'write' });
      assert.equal(job.needs, 'build');
      assert.equal(job.environment.name, 'github-pages');
    } else {
      assert.ok(!job.permissions, `job ${id} must inherit contents: read`);
    }
  }
});

test('docs-deploy.yml actions pinned to SHAs with version comments', () => {
  for (const step of deploySteps) {
    if (step.uses && !step.uses.startsWith('./')) {
      assert.match(step.uses, /^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/, step.uses);
    }
  }
  for (const line of docsDeployText.split('\n')) {
    const m = line.match(/^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/);
    if (!m || m[1].startsWith('./')) continue;
    assert.match(m[2], /^\s+#\s*v\d+/, `missing "# v<version>" comment: ${line.trim()}`);
  }
  for (const step of deploySteps) {
    if (step.uses?.startsWith('actions/checkout@')) {
      assert.equal(step.with?.['persist-credentials'], false);
    }
  }
});

test('docs-deploy.yml: every job has timeout-minutes', () => {
  for (const [id, job] of deployJobs) {
    assert.equal(typeof job['timeout-minutes'], 'number', `job ${id} has no timeout-minutes`);
  }
});

test('docs-deploy.yml: no secrets and no ${{ }} in run', () => {
  assert.doesNotMatch(docsDeployText, /secrets\s*[.[]/);
  for (const step of deploySteps) {
    if (step.run) assert.doesNotMatch(step.run, /\$\{\{/, `expression in run: ${step.name}`);
  }
});

// The built-reference test only runs against a build, so the tests must follow the build step.
function assertUnitTestsAfterBuild(steps) {
  const runs = steps.map((s) => s.run ?? '');
  const build = runs.findIndex((r) => /turbo run build --filter=@feedbouncer\/docs/.test(r));
  const tests = runs.findIndex((r) => /pnpm --filter @feedbouncer\/docs test$/.test(r.trim()));
  assert.ok(build >= 0 && tests > build, 'docs unit tests must run after the docs build');
}

test('the docs-check action builds, tests, runs the site checks and checks links', () => {
  const steps = docsCheck.runs.steps;
  const runs = steps.map((s) => s.run ?? '').join('\n');
  assert.match(runs, /turbo run build --filter=@feedbouncer\/docs/);
  assert.match(runs, /@feedbouncer\/docs run test:site/);
  assertUnitTestsAfterBuild(steps);
  const lychee = steps.find((s) => s.uses?.startsWith('lycheeverse/lychee-action@'));
  assert.equal(lychee.with.fail, true);
  assert.match(lychee.with.args, /--config apps\/docs\/lychee\.toml/);
});

test('the docs PR gate and the deploy build both run the docs-check action', () => {
  for (const steps of [workflow.jobs.docs.steps, docsDeploy.jobs.build.steps]) {
    assert.ok(steps.some((s) => s.uses === './.github/actions/docs-check'));
  }
});

test('the docs job checks out full history', () => {
  const job = workflow.jobs.docs;
  assert.equal(job?.name, 'Docs');
  assert.equal(job['timeout-minutes'], 25);
  const checkout = job.steps.find((s) => s.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with['fetch-depth'], 0);
});
