import { describe, expect, it } from 'vitest';
import { checkRoutes } from '../scripts/check-routes.mjs';

type Check = (
  built: string[],
  lock: string[],
  redirects: { from: string | string[]; to: string }[],
) => { missing: string[]; unlocked: string[] };
const check = checkRoutes as Check;

describe('checkRoutes', () => {
  it('flags a renamed page without a redirect', () => {
    const result = check(['/docs/new/'], ['/docs/old/'], []);
    expect(result.missing).toEqual(['/docs/old/']);
    expect(result.unlocked).toEqual(['/docs/new/']);
  });

  it('accepts it with a redirect', () => {
    const result = check(
      ['/docs/new/'],
      ['/docs/old/', '/docs/other/'],
      [
        { from: '/docs/old/', to: '/docs/new/' },
        { from: ['/docs/other/'], to: '/docs/new/' },
      ],
    );
    expect(result.missing).toEqual([]);
  });
});
