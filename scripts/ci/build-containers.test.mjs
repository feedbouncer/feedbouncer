// Guards the container publishing workflow: who may publish, what gets tagged,
// and that both architectures are present before anything is made public.
// If a change here is intentional, update the Global Constraints it encodes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { parse } from 'yaml';

const read = (rel) => readFile(new URL(`../../${rel}`, import.meta.url), 'utf8');
const text = await read('.github/workflows/build-containers.yml');
const wf = parse(text);
const pkg = JSON.parse(await read('package.json'));
const jobs = Object.entries(wf.jobs);

const APPS = ['api', 'worker', 'web'];
const ARCHES = ['amd64', 'arm64'];
const IMAGE = (app) => `ghcr.io/feedbouncer/feedbouncer-${app}`;

function allSteps() {
  return jobs.flatMap(([, job]) => job.steps ?? []);
}

const build = wf.jobs.build;
const publish = wf.jobs.publish;
const buildPush = build.steps.find((s) => s.uses?.startsWith('docker/build-push-action@'));
const createIdx = publish.steps.findIndex((s) => s.run?.includes('imagetools create'));
const createStep = publish.steps[createIdx];

test('triggers: push to main and manual dispatch only, no path filters', () => {
  assert.deepEqual(Object.keys(wf.on).sort(), ['push', 'workflow_dispatch']);
  assert.deepEqual(wf.on.push.branches, ['main']);
  assert.ok(!wf.on.push.paths && !wf.on.push['paths-ignore'] && !wf.on.push.tags);
});

test('runs one main build at a time, never cancelling an in-progress run', () => {
  assert.equal(wf.concurrency['cancel-in-progress'], false);
  assert.match(String(wf.concurrency.group), /^build-containers/);
});

test('token: contents read at top level; only build and publish add packages write', () => {
  assert.deepEqual(wf.permissions, { contents: 'read' });
  for (const [id, job] of jobs) {
    if (['build', 'publish'].includes(id))
      assert.deepEqual(job.permissions, { contents: 'read', packages: 'write' });
    else assert.ok(!job.permissions, `job ${id} must not widen permissions`);
  }
});

test('no secrets are referenced; registry login uses the workflow token', () => {
  assert.doesNotMatch(text, /secrets\s*[.[]/);
  const logins = allSteps().filter((s) => s.uses?.startsWith('docker/login-action@'));
  assert.ok(logins.length >= 2, 'build and publish both log in');
  for (const step of logins) {
    assert.equal(step.with.registry, 'ghcr.io');
    assert.equal(step.with.password, '${{ github.token }}');
  }
});

test('every job is limited to this repository on main', () => {
  for (const [id, job] of jobs) {
    assert.match(String(job.if), /github\.repository == 'feedbouncer\/feedbouncer'/, id);
    assert.match(String(job.if), /github\.ref == 'refs\/heads\/main'/, id);
  }
});

test('every job has a timeout', () => {
  for (const [id, job] of jobs) {
    assert.equal(typeof job['timeout-minutes'], 'number', `job ${id} has no timeout-minutes`);
  }
});

test('third-party actions are pinned to full commit SHAs with version comments', () => {
  for (const step of allSteps()) {
    if (!step.uses || step.uses.startsWith('./')) continue;
    assert.match(step.uses, /@[0-9a-f]{40}$/, `unpinned action: ${step.uses}`);
  }
  // YAML parsing drops comments, so check the raw lines for the version tag.
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/);
    if (!m || m[1].startsWith('./')) continue;
    assert.match(m[2], /^\s+#\s*v\d+/, `missing "# v<version>" comment: ${line.trim()}`);
  }
});

test('no ${{ }} expressions inside run scripts', () => {
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

test('build matrix is every app on both arches, native runners, fail-fast off', () => {
  assert.deepEqual(build.strategy.matrix.app, APPS);
  assert.deepEqual(build.strategy.matrix.platform, [
    { arch: 'amd64', runner: 'ubuntu-24.04' },
    { arch: 'arm64', runner: 'ubuntu-24.04-arm' },
  ]);
  assert.equal(build['runs-on'], '${{ matrix.platform.runner }}');
  assert.equal(build.strategy['fail-fast'], false);
});

test('build legs push by digest only, untagged, without attestations', () => {
  const w = buildPush.with;
  assert.equal(w.context, '.');
  assert.equal(w.file, 'apps/${{ matrix.app }}/Dockerfile');
  assert.equal(w.platforms, 'linux/${{ matrix.platform.arch }}');
  assert.equal(w.provenance, false);
  assert.ok(!('tags' in w));
  for (const part of ['push-by-digest=true', 'name-canonical=true', 'push=true'])
    assert.ok(String(w.outputs).includes(part), `outputs lacks ${part}`);
  for (const key of ['cache-from', 'cache-to']) {
    const v = String(w[key]);
    assert.ok(v.includes('type=gha'), key);
    const scope = v.match(/scope=(.+)$/)?.[1] ?? '';
    assert.ok(scope.includes('${{ matrix.app }}'), `${key} scope lacks app`);
    assert.ok(scope.includes('${{ matrix.platform.arch }}'), `${key} scope lacks arch`);
  }
});

test('OCI labels: source, revision and the repo license', () => {
  const labels = String(buildPush.with.labels);
  assert.ok(labels.includes('org.opencontainers.image.source='));
  assert.ok(labels.includes('org.opencontainers.image.revision=${{ github.sha }}'));
  assert.ok(labels.includes(`org.opencontainers.image.licenses=${pkg.license}`));
});

test('publish needs build, runs after partial failure, per app, fail-fast off', () => {
  assert.equal(publish.needs, 'build');
  assert.ok(String(publish.if).includes('!cancelled()'));
  assert.deepEqual(
    publish.strategy.matrix.include.map((i) => i.app),
    APPS,
  );
  for (const i of publish.strategy.matrix.include)
    assert.ok(i.description && String(i.description).trim(), `${i.app} has a description`);
  assert.equal(publish.strategy['fail-fast'], false);
});

test('publish checks both digests before creating the manifest', () => {
  assert.ok(createIdx > 0, 'create step exists');
  const check = publish.steps
    .slice(0, createIdx)
    .find((s) => ARCHES.every((a) => s.run?.includes(a)) && s.run.includes('exit 1'));
  assert.ok(check, 'a step before create checks amd64 and arm64 and can fail');
});

test('publish writes both tags in a single imagetools create', () => {
  assert.equal(createStep.run.split('imagetools create').length - 1, 1);
  assert.ok(createStep.run.includes('$IMAGE:$GITHUB_SHA'));
  assert.ok(createStep.run.includes('$IMAGE:latest'));
});

test('publish only moves latest when the commit is main HEAD', () => {
  assert.match(createStep.run, /commits\/main/);
  assert.match(createStep.run, /"\$head" = "\$GITHUB_SHA"/);
});

test('publish verifies the pushed index has exactly linux/amd64 and linux/arm64', () => {
  const verify = publish.steps
    .slice(createIdx + 1)
    .find(
      (s) => s.run?.includes('imagetools inspect') && s.run.includes('linux/amd64,linux/arm64'),
    );
  assert.ok(verify, 'a step after create inspects the index');
});

test('image names are exact lowercase literals', () => {
  const refs = text.match(/ghcr\.io\/[\w./-]*(?:\$\{\{ matrix\.app \}\})?[\w-]*/g) ?? [];
  assert.ok(refs.length > 0);
  for (const ref of refs)
    assert.match(
      ref,
      /^ghcr\.io\/feedbouncer\/feedbouncer-(\$\{\{ matrix\.app \}\}|api|worker|web)$/,
      ref,
    );
  for (const job of [build, publish]) {
    assert.equal(job.env.IMAGE, IMAGE('${{ matrix.app }}'));
    assert.doesNotMatch(String(job.env.IMAGE), /github\.repository|repository_owner/);
  }
});

test('only github.com and ghcr.io hosts appear', () => {
  const hosts = [...text.matchAll(/https?:\/\/([^/\s'"]+)/g)].map((m) => m[1]);
  for (const host of hosts) assert.ok(['github.com', 'ghcr.io'].includes(host), host);
});

test('each published app has a Dockerfile whose last stage is runtime', async () => {
  for (const app of APPS) {
    const dockerfile = await read(`apps/${app}/Dockerfile`);
    const stages = [...dockerfile.matchAll(/^FROM .* AS (\S+)$/gim)].map((m) => m[1]);
    assert.equal(stages.at(-1), 'runtime', app);
    assert.match(dockerfile, /^ARG NODE_VERSION/m, app);
  }
});
