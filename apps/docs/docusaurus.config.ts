import { existsSync, readFileSync } from 'node:fs';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import type * as OpenApiPlugin from 'docusaurus-plugin-openapi-docs';
import { darkCodeTheme, lightCodeTheme } from './prism-theme';
import { BASE_URL, REPO, ROADMAP_ROUTE, SITE_URL } from './site.config';

const versionsFile = new URL('./versions.json', import.meta.url);
const versions: string[] = existsSync(versionsFile)
  ? (JSON.parse(readFileSync(versionsFile, 'utf8')) as string[])
  : [];
const redirects = JSON.parse(
  readFileSync(new URL('./redirects.json', import.meta.url), 'utf8'),
) as { from: string; to: string }[];

const docsVersions = {
  current: {
    label: 'main (unreleased)',
    path: versions.length ? 'next' : '',
    banner: 'unreleased' as const,
    badge: true,
  },
  ...Object.fromEntries(
    versions.map((name) => [
      name,
      {
        label: `v${name}`,
        badge: true,
        banner: name === versions[0] ? ('none' as const) : ('unmaintained' as const),
      },
    ]),
  ),
};

const config: Config = {
  title: 'FeedBouncer',
  tagline: 'Documentation for FeedBouncer',
  url: SITE_URL,
  baseUrl: BASE_URL,
  trailingSlash: true,
  organizationName: REPO.split('/')[0]!,
  projectName: REPO.split('/')[1]!,
  onBrokenLinks: 'throw',
  onBrokenAnchors: 'throw',
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'throw',
      onBrokenMarkdownImages: 'throw',
    },
  },
  i18n: { defaultLocale: 'en', locales: ['en'] },
  presets: [
    [
      'classic',
      {
        docs: {
          routeBasePath: 'docs',
          sidebarPath: './sidebars.ts',
          showLastUpdateTime: true,
          docItemComponent: '@theme/ApiItem',
          includeCurrentVersion: true,
          lastVersion: versions[0] ?? 'current',
          versions: docsVersions,
          editUrl: `https://github.com/${REPO}/tree/main/apps/docs/`,
        },
        blog: false,
        theme: { customCss: './src/css/custom.css' },
      } satisfies Preset.Options,
    ],
  ],
  plugins: [
    [
      'docusaurus-plugin-openapi-docs',
      {
        id: 'openapi',
        docsPluginId: 'classic',
        config: {
          feedbouncer: {
            specPath: 'docs/_generated/openapi.json',
            outputDir: 'docs/api/reference',
            sidebarOptions: { groupPathsBy: 'tag' },
            hideSendButton: true,
            showSchemas: true,
          } satisfies OpenApiPlugin.Options,
        },
      },
    ],
    ['@docusaurus/plugin-client-redirects', { redirects }],
  ],
  themes: ['docusaurus-theme-openapi-docs'],
  themeConfig: {
    api: { hideGeneratedSnippets: true },
    // Token colors that keep 4.5:1 contrast on the code background (the default palette does not).
    prism: { theme: lightCodeTheme, darkTheme: darkCodeTheme },
    languageTabs: [{ language: 'curl', highlight: 'bash' }],
    navbar: {
      title: 'FeedBouncer',
      items: [
        { type: 'docSidebar', sidebarId: 'docs', position: 'left', label: 'Docs' },
        {
          type: 'docsVersionDropdown',
          position: 'right',
          dropdownItemsAfter: [{ to: '/versions', label: 'All versions' }],
        },
        { type: 'search', position: 'right' },
        { href: `https://github.com/${REPO}`, label: 'GitHub', position: 'right' },
      ],
    },
    footer: {
      links: [
        {
          title: 'Project',
          items: [
            { label: 'Roadmap', to: ROADMAP_ROUTE },
            { label: 'GitHub', href: `https://github.com/${REPO}` },
          ],
        },
      ],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
