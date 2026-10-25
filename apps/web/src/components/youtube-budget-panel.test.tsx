import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { YouTubeBudgetStatus } from '../lib/youtube-budget';
import { YouTubeBudgetView } from './youtube-budget-panel';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const RESET = '2026-10-26T07:00:00.000Z';

function status(over: {
  mode?: YouTubeBudgetStatus['today']['mode'];
  today?: Partial<YouTubeBudgetStatus['today']>;
  settings?: Partial<YouTubeBudgetStatus['settings']>;
  backlog?: Partial<YouTubeBudgetStatus['backlog']>;
}): YouTubeBudgetStatus {
  return {
    settings: { dailyBudgetUnits: 2000, dryRun: false, protectedAuthorIds: [], ...over.settings },
    limits: { maxBudgetUnits: 9000, projectQuotaUnits: 10_000 },
    today: {
      pacificDay: '2026-10-25',
      resetAt: RESET,
      mode: over.mode ?? 'active',
      budgetUnits: 2000,
      spentUnits: 600,
      readsSpentUnits: 100,
      writesSpentUnits: 500,
      readReserveUnits: 300,
      remainingUnits: 1400,
      simulatedUnits: 0,
      pausedUntil: null,
      ...over.today,
    },
    backlog: { ban: 1, reject: 2, hold: 3, publish: 0, skippedOverflowToday: 0, ...over.backlog },
    nextReadAt: null,
    lastErrorCode: null,
  };
}

const render = (s: YouTubeBudgetStatus, canManage = true) =>
  renderToStaticMarkup(
    <YouTubeBudgetView orgId="o" brandId="b" connectionId="c" canManage={canManage} initial={s} />,
  );

describe('YouTubeBudgetView', () => {
  it('renders each mode banner with counts', () => {
    const waiting = { ban: 1, reject: 2, hold: 3, publish: 4 };
    const paused = render(
      status({
        mode: 'paused',
        today: { pausedUntil: '2026-10-25T20:00:00.000Z' },
        backlog: waiting,
      }),
    );
    expect(paused).toContain(
      'YouTube&#x27;s daily quota for this FeedBouncer installation is used up. Moderation resumes at ',
    );
    expect(paused).toContain('2026-10-25T20:00:00.000Z');
    expect(paused).toContain('. 10 actions are waiting.');
    const readOnly = render(status({ mode: 'read_only', backlog: waiting }));
    expect(readOnly).toContain(
      'Budget too low for moderation actions. New comments are still checked; 10 actions are waiting.',
    );
    const exhausted = render(status({ mode: 'exhausted', backlog: waiting }));
    expect(exhausted).toContain('Today&#x27;s budget is spent. 10 actions wait until ');
    expect(exhausted).toContain(RESET);
    expect(render(status({ mode: 'disabled' }))).toContain(
      'Budget is 0. FeedBouncer is not calling YouTube for this channel.',
    );
    const active = render(status({ mode: 'active' }));
    for (const copy of [
      'quota for this FeedBouncer',
      'Budget too low',
      'budget is spent',
      'Budget is 0',
    ])
      expect(active).not.toContain(copy);
  });

  it('shows spend, reads and writes split, reserve, remaining and the reset time', () => {
    const html = render(status({}));
    expect(html).toContain('600 / 2000 units used');
    expect(html).toContain('Reads: 100');
    expect(html).toContain('Writes: 500');
    expect(html).toContain('Read reserve: 300');
    expect(html).toContain('Remaining: 1400');
    expect(html).toContain('Resets at ');
    expect(html).toContain('(midnight Pacific)');
  });

  it('shows the backlog by tier and the overflow count', () => {
    const html = render(status({ backlog: { publish: 4, skippedOverflowToday: 7 } }));
    expect(html).toContain('Hold for review: 3');
    expect(html).toContain('Reject: 2');
    expect(html).toContain('Reject and ban author (undo in YouTube Studio): 1');
    expect(html).toContain('Publish: 4');
    expect(html).toContain('7 actions were skipped today because the backlog is full.');
  });

  it('shows ban as not undoable here', () => {
    expect(render(status({}))).toContain('Reject and ban author (undo in YouTube Studio)');
  });

  it('shows the dry-run badge only while dry run is on', () => {
    const badge = 'Dry run: actions are logged with their quota cost, not applied';
    expect(render(status({ settings: { dryRun: true } }))).toContain(badge);
    expect(render(status({}))).not.toContain(badge);
  });

  it('offers budget, dry-run and protected channel controls to managers', () => {
    const html = render(status({ settings: { protectedAuthorIds: ['UCaaaaaaaaaaaaaaaaaaaaaa'] } }));
    expect(html).toContain('max="9000"');
    expect(html).toContain('value="2000"');
    expect(html).toContain('<textarea');
    expect(html).toContain('UCaaaaaaaaaaaaaaaaaaaaaa');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain(
      'Channel moderators: FeedBouncer will never ban these channels. YouTube does not let apps read your moderator list.',
    );
    expect(html).toContain('>Save</button>');
  });

  it('hides edit controls without canManage', () => {
    const html = render(status({}), false);
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('<button');
    expect(html).toContain('600 / 2000 units used');
  });

  it('renders values as text, never markup', () => {
    const html = render(
      status({ settings: { protectedAuthorIds: ['<img src=x onerror=alert(1)>'] } }),
    );
    expect(html).not.toContain('<img');
  });
});
