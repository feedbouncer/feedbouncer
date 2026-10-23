import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { BASE_URL } from '../site.config';
import { DISCLAIMER, GROUPS } from '../test/lib/roadmap';

const sitemap = readFileSync(resolve(process.cwd(), 'build/sitemap.xml'), 'utf8');
const routes = [...new Set([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => loc!))]
  .map((loc) => new URL(loc).pathname)
  .sort();
const docRoutes = routes.filter((route) => route.startsWith(`${BASE_URL}docs/`));
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/**
 * The third-party OpenAPI theme renders nested lists as <ul><div>, a carousel of unnamed arrow
 * buttons, a security heading out of order and an unfocusable scroll region. We cannot change that
 * markup, so these four rules
 * skip the theme's one wrapper element. Every other rule, and these rules everywhere else,
 * still apply to API pages.
 */
const OPENAPI_THEME = '.theme-api-markdown';
const OPENAPI_THEME_RULES = ['list', 'button-name', 'heading-order', 'scrollable-region-focusable'];

const NOT_FOUND = `${BASE_URL}__missing__/`;

async function open(page: Page, route: string): Promise<void> {
  const response = await page.goto(route);
  expect(response?.status(), route).toBe(200);
}

test('the sitemap lists pages', () => {
  expect(routes.length).toBeGreaterThan(50);
  expect(docRoutes.length).toBeGreaterThan(30);
});

for (const route of routes) {
  test.describe(route, () => {
    test('no WCAG A/AA violations', async ({ page }) => {
      await open(page, route);
      const all = await new AxeBuilder({ page })
        .withTags(WCAG_TAGS)
        .disableRules(OPENAPI_THEME_RULES)
        .analyze();
      const outsideTheme = await new AxeBuilder({ page })
        .withRules(OPENAPI_THEME_RULES)
        .exclude(OPENAPI_THEME)
        .analyze();
      const violations = [...all.violations, ...outsideTheme.violations];
      expect(
        violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
      ).toEqual([]);
    });

    test('heading order and a single h1', async ({ page }) => {
      await open(page, route);
      const { violations } = await new AxeBuilder({ page })
        .withRules(['heading-order', 'page-has-heading-one'])
        .exclude(OPENAPI_THEME)
        .analyze();
      expect(violations.map((v) => v.id)).toEqual([]);
      await expect(page.locator('h1')).toHaveCount(1);
    });

    test('readable at 375px without horizontal page scroll', async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 800 });
      await open(page, route);
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
      // Code blocks scroll inside their own box instead of widening the page.
      const overflowing = await page.evaluate(() =>
        [...document.querySelectorAll('pre')]
          .filter((pre) => pre.getBoundingClientRect().right > document.documentElement.clientWidth)
          .map((pre) => (pre.textContent ?? '').slice(0, 40)),
      );
      expect(overflowing).toEqual([]);
    });
  });
}

for (const route of docRoutes) {
  test(`${route} shows a version badge and a last-updated date`, async ({ page }) => {
    await open(page, route);
    await expect(page.locator('.theme-doc-version-badge').first()).toBeVisible();
    await expect(page.locator('.theme-last-updated').first()).toBeVisible();
  });
}

test('the "not found" page is served with the site chrome', async ({ page }) => {
  const response = await page.goto(NOT_FOUND);
  expect(response?.status()).toBe(404);
  await expect(page.locator('h1')).toHaveCount(1);
});

test.describe('code blocks', () => {
  const samples = [
    `${BASE_URL}docs/api/authentication/`,
    `${BASE_URL}docs/mcp/clients/desktop-app/`,
    ...docRoutes.filter((route) => route.includes('/api/reference/')).slice(0, 2),
  ];
  for (const route of samples) {
    test(`${route} has keyboard-reachable copy buttons with an accessible name`, async ({
      page,
    }) => {
      await open(page, route);
      const buttons = page.locator('.theme-code-block pre ~ div button');
      // Copy buttons are added on the client, so wait for hydration to finish.
      await expect(buttons.first()).toBeAttached();
      const count = await buttons.count();
      for (let i = 0; i < count; i += 1) {
        const button = buttons.nth(i);
        await expect(button).toHaveAttribute('aria-label', /\S/);
        await expect(button).toHaveAttribute('type', 'button');
        // Hidden until hover/focus in the theme, but never removed from the tab order.
        await expect(button).not.toHaveAttribute('tabindex', '-1');
      }
      // Hidden blocks (inactive tabs) are skipped; the first visible one takes focus.
      const first = buttons.filter({ visible: true }).first();
      await first.focus();
      await expect(first).toBeFocused();
      await expect(first).toBeVisible();
    });
  }
});

test('first Tab focuses the skip-to-content link', async ({ page }) => {
  await open(page, `${BASE_URL}docs/concepts/overview/`);
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to main content' });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
});

test.describe('search', () => {
  test('a real term finds the idempotency guide, by keyboard', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
    page.on('pageerror', (error) => errors.push(error.message));
    await open(page, `${BASE_URL}docs/concepts/overview/`);
    await page.getByRole('searchbox', { name: 'Search the documentation' }).focus();
    await page.keyboard.type('idempotency');
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/search\/\?q=idempotency/);
    const results = page.locator('[aria-live="polite"] li a');
    await expect(results.first()).toBeVisible();
    await expect(results.first()).toHaveAttribute('href', /\/docs\/api\/idempotency\//);
    // Tab from the search field to the first result.
    await page.locator('#search-page-input').focus();
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press('Tab');
      if (await results.first().evaluate((el) => el === document.activeElement)) break;
    }
    await expect(results.first()).toBeFocused();
    expect(errors).toEqual([]);
  });

  test('nonsense shows suggestions', async ({ page }) => {
    await open(page, `${BASE_URL}search/`);
    await page.locator('#search-page-input').focus();
    await page.keyboard.type('zzqxjv');
    await page.keyboard.press('Enter');
    await page.waitForURL(/q=zzqxjv/);
    await expect(page.getByText("No pages match 'zzqxjv'")).toBeVisible();
    await expect(page.locator('[aria-live="polite"] li a').first()).toBeVisible();
  });
});

test('unreleased banner is shown on main (unreleased) pages', async ({ page }) => {
  await open(page, `${BASE_URL}docs/concepts/overview/`);
  const banner = page.locator('.theme-doc-version-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/unreleased/i);
});

test.describe('roadmap without JavaScript', () => {
  test.use({ javaScriptEnabled: false });
  for (const width of [1280, 375]) {
    test(`at ${width}px shows groups, disclaimer and date`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await open(page, `${BASE_URL}roadmap/`);
      await expect(page.getByRole('heading', { level: 1, name: 'Roadmap' })).toBeVisible();
      // The accessible name also holds the theme's "Direct link to <group>" anchor label.
      for (const g of GROUPS)
        await expect(
          page.getByRole('heading', { level: 2, name: new RegExp(`^${g}`) }),
        ).toBeVisible();
      await expect(page.getByText(DISCLAIMER, { exact: true })).toBeVisible();
      await expect(page.locator('p', { hasText: 'Last updated:' })).toBeVisible();
    });
  }
});

for (const from of [BASE_URL, `${BASE_URL}docs/concepts/overview/`]) {
  test(`footer Roadmap link on ${from} opens the roadmap`, async ({ page }) => {
    await open(page, from);
    const link = page.locator('footer').getByRole('link', { name: 'Roadmap', exact: true });
    await expect(link).toHaveAttribute('href', `${BASE_URL}roadmap/`);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`${BASE_URL}roadmap/$`));
    await expect(page.getByRole('heading', { level: 1, name: 'Roadmap' })).toBeVisible();
  });
}
