import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { MAX_DOMAINS_PER_BRAND, MAX_RULES_PER_BRAND } from '@feedbouncer/rules';
import reference from '../../../docs/reference/product-reference.json';
import { exampleFiles } from './lib/examples';
import openapi from '../../../docs/api/openapi.json';
import tools from '../../../docs/mcp/tools.json';
import { SUPPORTED_MCP_CLIENTS } from '../site.config';
import { appRoot, body, codeBlocks, headings } from './lib/content';

const rules = reference.rules;
const page = (name: string) => join(appRoot, 'docs/rules', name);
const h3s = (name: string) =>
  headings(body(page(name)))
    .filter((h) => h.depth === 3)
    .map((h) => h.text);

describe('rules section coverage', () => {
  it('the reference data lists the conditions and steps the pages are written for', () => {
    expect(rules.conditions.map((c) => c.type)).toEqual([
      'keyword',
      'regex',
      'link_domain',
      'emoji',
      'author',
      'competitor',
    ]);
    expect(rules.steps.map((s) => s.type)).toEqual([
      'flag_for_review',
      'private_reply',
      'auto_reply',
      'hide',
      'ban',
      'delete',
    ]);
  });

  it('conditions.mdx has exactly one "### `<type>`" per condition type', () => {
    expect(h3s('conditions.mdx')).toEqual(rules.conditions.map((c) => `\`${c.type}\``));
  });

  it('conditions.mdx summarises every condition type in its table', () => {
    const text = body(page('conditions.mdx'));
    expect(text).toMatch(/<ReferenceTable\s+kind="conditions"/);
    for (const { type } of rules.conditions) expect(text, type).toMatch(new RegExp(`\\b${type}:`));
  });

  it('actions.mdx has exactly one "### `<step>`" per step type and a Conflicts section', () => {
    expect(h3s('actions.mdx')).toEqual(rules.steps.map((s) => `\`${s.type}\``));
    expect(headings(body(page('actions.mdx')))).toContainEqual({ depth: 2, text: 'Conflicts' });
  });

  it('actions.mdx explains every conflict in the reference data', () => {
    const text = body(page('actions.mdx'));
    expect(text).toMatch(/<ReferenceTable\s+kind="conflicts"/);
    for (const [a, b] of rules.conflicts) expect(text, `${a}+${b}`).toContain(`'${a}+${b}'`);
  });

  it('actions.mdx names the confirm flags the code requires', () => {
    const text = body(page('actions.mdx'));
    for (const flag of ['confirmIrreversible', 'confirmHardToReverse'])
      expect(text).toContain(flag);
  });

  it('limits.mdx is built from the reference limits and states the brand limits', () => {
    const text = body(page('limits.mdx'));
    expect(text).toContain('rules.limits');
    expect(text).toContain(`${MAX_RULES_PER_BRAND} rules per brand`);
    expect(text).toContain(`${MAX_DOMAINS_PER_BRAND} own domains per brand`);
  });

  it('precedence.md covers no-match behaviour and the rule budget', () => {
    expect(headings(body(page('precedence.md')))).toContainEqual({
      depth: 2,
      text: 'When no rule matches',
    });
    expect(body(page('precedence.md'))).toContain(`${rules.ruleBudgetMs} ms`);
  });

  it('examples.mdx renders every example file once', () => {
    const text = body(page('examples.mdx'));
    for (const file of exampleFiles()) {
      const id = /^\s*import\s+(\w+)\s+from\s+'\.\/examples\/([^']+)';?\s*$/gm;
      const idents = [...text.matchAll(id)].filter((m) => m[2] === file).map((m) => m[1]!);
      expect(idents, `${file} imported once`).toHaveLength(1);
      const uses = text.match(new RegExp(`<WorkedExample\\s+data=\\{${idents[0]}\\}`, 'g'));
      expect(uses, `${file} rendered once`).toHaveLength(1);
    }
  });

  it('repeated-comments example labels duplicate detection as not supported', () => {
    expect(body(page('examples.mdx'))).toMatch(
      /<FeatureStatus status="unsupported">[\s\S]*duplicate[\s\S]*<\/FeatureStatus>/i,
    );
  });
});

const apiPage = (name: string) => join(appRoot, 'docs/api', name);
const GUIDES = [
  'overview.md',
  'quickstart.md',
  'authentication.md',
  'errors.mdx',
  'pagination.md',
  'rate-limits.mdx',
  'idempotency.md',
  'webhooks.md',
  'moderation-check.md',
];

describe('api guides coverage', () => {
  it('every /v1 path in api guides exists in openapi.json', () => {
    const templates = Object.keys(openapi.paths).map(
      (path) => new RegExp(`^${path.replace(/\{[^}]+\}/g, '[^/]+')}$`),
    );
    let seen = 0;
    for (const guide of GUIDES) {
      const text = body(apiPage(guide));
      for (const m of text.matchAll(/\/v1\/[\w\-/<>{}.]*[\w>}]/g)) {
        seen++;
        const path = m[0].replace(/<[A-Z][A-Z0-9_]*>/g, '{id}');
        expect(
          templates.some((t) => t.test(path)),
          `${guide}: ${m[0]}`,
        ).toBe(true);
      }
    }
    expect(seen).toBeGreaterThan(20);
  });

  it('errors.mdx renders the generated error table and explains the Error shape fields', () => {
    const text = body(apiPage('errors.mdx'));
    expect(text).toMatch(/<ReferenceTable\s+kind="errors"/);
    expect(text).toContain('reference.api.errors');
    for (const field of ['code', 'message']) expect(text).toContain(`\`${field}\``);
  });

  it('errors.mdx has a meaning for every error code in the reference data', () => {
    const text = body(apiPage('errors.mdx'));
    for (const { code } of reference.api.errors)
      expect(text, code).toMatch(new RegExp(`\\b${code}:`));
  });

  it('errors.mdx states the 413 limit from the reference data', () => {
    const text = body(apiPage('errors.mdx'));
    expect(text).toContain('reference.api.requestBodyLimitBytes');
    expect(text).toMatch(/`413`[^\n]*`invalid_request`/);
    expect(reference.api.requestBodyLimitBytes).toBe(64 * 1024);
  });

  it('quickstart shows the exported host and a GET /v1/key call', () => {
    const blocks = codeBlocks(body(apiPage('quickstart.md'))).map((b) => b.body);
    expect(
      blocks.some((b) => b.includes('export FEEDBOUNCER_URL=https://feedbouncer.example.com')),
    ).toBe(true);
    expect(blocks.some((b) => /curl[^\n]*"?\$FEEDBOUNCER_URL\/v1\/key"?/.test(b))).toBe(true);
  });

  it('authentication lists the scopes in order', () => {
    const text = body(apiPage('authentication.md'));
    const at = reference.api.scopes.map((s) => text.indexOf(`| \`${s}\``));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('moderation-check.md covers every reason code', () => {
    const text = body(apiPage('moderation-check.md'));
    for (const r of reference.moderationCheck.reasons) expect(text, r).toContain(`\`${r}\``);
  });

  it('every guide is in the API reference sidebar', () => {
    const sidebar = readFileSync(join(appRoot, 'sidebars.ts'), 'utf8');
    for (const g of GUIDES) expect(sidebar, g).toContain(`'api/${g.replace(/\.mdx?$/, '')}'`);
  });
});

const build = join(appRoot, 'build');
const reference_ = join(appRoot, 'docs/api/reference');

// Needs both a build and the generated pages it came from (the sidebar stub alone does not count).
const hasBuiltReference =
  existsSync(join(build, 'docs/api/reference')) &&
  existsSync(reference_) &&
  readdirSync(reference_).some((n) => n.endsWith('.api.mdx'));

describe('built API reference', () => {
  // The curl sample reaches the browser inside each page's compressed `api` data, not as static HTML,
  // so the check decodes that data from the generated page and finds it in the built assets.
  it.skipIf(!hasBuiltReference)(
    'every operation has a built reference page containing its curl sample',
    () => {
      const assets = join(build, 'assets/js');
      const chunks = readdirSync(assets).map((f) => readFileSync(join(assets, f), 'utf8'));
      const pages = new Map<string, { slug: string; blob: string; source: string }>();
      for (const f of readdirSync(reference_).filter((n) => n.endsWith('.api.mdx'))) {
        const blob = /^api: (.+)$/m.exec(readFileSync(join(reference_, f), 'utf8'))?.[1];
        if (!blob) continue;
        const data = JSON.parse(inflateSync(Buffer.from(blob, 'base64')).toString()) as {
          operationId?: string;
          codeSamples?: { source: string }[];
          'x-codeSamples'?: { source: string }[];
        };
        if (data.operationId)
          pages.set(data.operationId, {
            slug: f.replace(/\.api\.mdx$/, ''),
            blob,
            source: (data.codeSamples ?? data['x-codeSamples'])?.[0]?.source ?? '',
          });
      }
      const ids = Object.values(openapi.paths).flatMap((item) =>
        Object.values(item as Record<string, { operationId?: string }>).flatMap((op) =>
          op.operationId ? [op.operationId] : [],
        ),
      );
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        const page = pages.get(id);
        expect(page, `${id} has a generated page`).toBeDefined();
        expect(existsSync(join(build, 'docs/api/reference', page!.slug, 'index.html')), id).toBe(
          true,
        );
        expect(page!.source, id).toContain('$FEEDBOUNCER_URL/v1');
        expect(
          chunks.some((c) => c.includes(page!.blob)),
          `${id} sample is in the build`,
        ).toBe(true);
      }
    },
  );
});

const rel = (file: string) => relative(appRoot, file);
const mcpDir = join(appRoot, 'docs/mcp');
const mcpPage = (name: string) => join(mcpDir, name);
const mcpFiles = () =>
  readdirSync(mcpDir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.mdx?$/.test(e.name))
    .map((e) => join(e.parentPath, e.name));
const CLIENT_H2S = ['Before you start', 'Add FeedBouncer', 'Check it works', 'If it does not work'];
const SAFE_KEY_VALUES = [
  '${input:feedbouncer-api-key}',
  '${env:FEEDBOUNCER_API_KEY}',
  '<FEEDBOUNCER_API_KEY>',
];

describe('mcp setup coverage', () => {
  it('tools.mdx has exactly one "## `<tool>`" per tool, each with <McpToolReference name>', () => {
    const text = body(mcpPage('tools.mdx'));
    const names = tools.tools.map((t) => t.name);
    const h2s = headings(text)
      .filter((h) => h.depth === 2 && /^`\w+`$/.test(h.text))
      .map((h) => h.text.slice(1, -1));
    expect([...h2s].sort()).toEqual([...names].sort());
    for (const name of names)
      expect(text, name).toMatch(
        new RegExp(`<McpToolReference\\s+name="${name}"\\s+manifest=\\{manifest\\}\\s*/>`),
      );
  });

  it('tools.mdx states the limits where MCP and the API differ', () => {
    const text = body(mcpPage('tools.mdx'));
    expect(text).toMatch(/idempotencyKey[^\n]*at most 64 characters/);
    expect(text).toMatch(/`limit`[^\n]*at most 50/);
  });

  it('there is one page per supported client plus generic, each with the four H2s in order', () => {
    for (const client of [...SUPPORTED_MCP_CLIENTS, 'generic']) {
      const file = mcpPage(`clients/${client}.md`);
      expect(existsSync(file), client).toBe(true);
      const h2s = headings(body(file))
        .filter((h) => h.depth === 2)
        .map((h) => h.text);
      expect(h2s, client).toEqual(CLIENT_H2S);
    }
  });

  it('every client page is in the MCP sidebar', () => {
    const sidebar = readFileSync(join(appRoot, 'sidebars.ts'), 'utf8');
    for (const client of [...SUPPORTED_MCP_CLIENTS, 'generic'])
      expect(sidebar, client).toContain(`'mcp/clients/${client}'`);
    for (const page of [
      'overview',
      'prerequisites',
      'authentication',
      'tools',
      'approvals',
      'verify',
      'troubleshooting',
    ])
      expect(sidebar, page).toContain(`'mcp/${page}'`);
  });

  it('MCP examples never place a literal key in config', () => {
    let seen = 0;
    for (const file of mcpFiles()) {
      for (const block of codeBlocks(body(file))) {
        for (const m of block.body.matchAll(
          /FEEDBOUNCER_API_KEY"?\s*[:=]\s*"?(\$\{[^}]*\}|[^"\s,}]*)/g,
        )) {
          if (m[1] === '') continue;
          seen++;
          expect(SAFE_KEY_VALUES, `${rel(file)}: ${m[0]}`).toContain(m[1]);
        }
      }
    }
    expect(seen).toBeGreaterThan(3);
  });

  it('vscode.md prompts for the key with a password input', () => {
    const json = codeBlocks(body(mcpPage('clients/vscode.md'))).find((b) =>
      b.body.includes('"inputs"'),
    );
    const config = JSON.parse(json!.body.replace(/^\s*\/\/.*$/gm, '')) as {
      inputs: { id: string; password?: boolean; type: string }[];
    };
    expect(config.inputs).toContainEqual(
      expect.objectContaining({ id: 'feedbouncer-api-key', type: 'promptString', password: true }),
    );
  });

  it('claude-code.md adds the server with --scope user or local, never project', () => {
    const text = body(mcpPage('clients/claude-code.md'));
    const adds = text.split('\n').filter((l) => l.includes('claude mcp add'));
    expect(adds.length).toBeGreaterThan(0);
    for (const line of adds) {
      expect(line).toMatch(/--scope (user|local)\b/);
      expect(line).toMatch(/--env FEEDBOUNCER_API_KEY=<FEEDBOUNCER_API_KEY>/);
    }
    expect(codeBlocks(text).some((b) => /--scope project/.test(b.body))).toBe(false);
  });

  it('overview labels remote MCP as planned', () => {
    expect(body(mcpPage('overview.md'))).toMatch(
      /<FeatureStatus status="planned">[\s\S]*remote[\s\S]*<\/FeatureStatus>/i,
    );
  });

  it('authentication builds its table from the server environment', () => {
    const text = body(mcpPage('authentication.mdx'));
    expect(text).toMatch(/<ReferenceTable\s+kind="mcp-env"/);
    expect(text).toContain('tools.env');
  });

  it('verify.md names the first request and the expected tool', () => {
    const text = body(mcpPage('verify.md'));
    expect(text).toContain('List my five most recent FeedBouncer comments.');
    expect(text).toContain('list_inbox');
  });

  it('troubleshooting covers each documented failure', () => {
    const h2s = headings(body(mcpPage('troubleshooting.md')))
      .filter((h) => h.depth === 2)
      .map((h) => h.text);
    expect(h2s).toEqual([
      'The server exits at start',
      'The API rejects the key',
      'A write tool says the key is read-only',
      'Connection refused or unreachable',
      'The client cannot find node',
      'The Windows config file is not found',
      'Rate limited',
    ]);
  });
});
