import { describe, expect, it, vi } from 'vitest';
import { parseDlqArgs, runDlq } from './dlq.js';

const ORG = '00000000-0000-4000-8000-000000000001';

describe('parseDlqArgs', () => {
  it('parses list filters', () => {
    expect(
      parseDlqArgs([
        'list',
        '--platform',
        'facebook',
        '--organization',
        ORG,
        '--reason',
        'needs_reconnection',
        '--limit',
        '20',
      ]),
    ).toEqual({
      cmd: 'list',
      showPayload: false,
      filter: {
        platform: 'facebook',
        organizationId: ORG,
        reason: 'needs_reconnection',
        states: ['dead_lettered'],
        limit: 20,
      },
    });
  });

  it('defaults list to dead-lettered rows, limit 50, and accepts --state and --since', () => {
    expect(parseDlqArgs(['list'])).toMatchObject({
      filter: { states: ['dead_lettered'], limit: 50 },
    });
    expect(
      parseDlqArgs(['list', '--state', 'resolved', '--since', '2026-10-01T00:00:00Z']),
    ).toMatchObject({
      filter: { states: ['resolved'], since: new Date('2026-10-01T00:00:00Z') },
    });
  });

  it('requires --yes and --platform for bulk replay', () => {
    expect(() => parseDlqArgs(['replay', '--platform', 'facebook'])).toThrow('--yes');
    expect(() => parseDlqArgs(['replay', '--yes'])).toThrow('--platform');
    expect(parseDlqArgs(['replay', '--platform', 'facebook', '--yes'])).toMatchObject({
      cmd: 'replay',
      dryRun: false,
    });
    expect(parseDlqArgs(['replay', '--id', ORG])).toMatchObject({
      cmd: 'replay',
      filter: { ids: [ORG] },
    });
  });

  it('never puts states on a replay filter', () => {
    const cmd = parseDlqArgs(['replay', '--platform', 'facebook', '--yes']);
    expect(cmd.filter).not.toHaveProperty('states');
  });

  it.each([
    [['list', '--platform', 'myspace']],
    [['list', '--organization', "x' OR 1=1 --"]],
    [['list', '--limit', '0']],
    [['list', '--limit', '501']],
    [['replay', '--id', 'not-a-uuid']],
    [['list', '--since', 'yesterday']],
    [['list', '--state', 'queued']],
    [['list', '--reason', "x' OR 1=1 --"]],
    [['frobnicate']],
    [[]],
  ])('rejects %o without echoing the value', (argv) => {
    expect(() => parseDlqArgs(argv)).toThrow();
    try {
      parseDlqArgs(argv);
    } catch (e) {
      expect(String(e)).not.toContain('OR 1=1');
      expect(String(e)).not.toContain('myspace');
    }
  });
});

describe('runDlq', () => {
  const entry = {
    id: 'i',
    payload: { body: 'user text' },
    scope: { organizationId: ORG, brandId: 'b', connectionId: 'c' },
    platform: 'facebook',
  };

  it('omits payload unless asked', async () => {
    const lines: string[] = [];
    const ledger = { listDeadLetters: vi.fn(async () => [entry]) };
    const deps = {
      ledger: ledger as never,
      producer: {} as never,
      out: (l: string) => lines.push(l),
    };
    await runDlq({ cmd: 'list', filter: { limit: 1 }, showPayload: false }, deps);
    expect(lines.join()).not.toContain('user text');
    expect(lines.join()).toContain(ORG);
    lines.length = 0;
    await runDlq({ cmd: 'list', filter: { limit: 1 }, showPayload: true }, deps);
    expect(lines.join()).toContain('user text');
  });

  it('dry-run lists candidates and replays nothing', async () => {
    const lines: string[] = [];
    const producer = { replay: vi.fn() };
    const ledger = { listDeadLetters: vi.fn(async () => [entry]) };
    const code = await runDlq(
      { cmd: 'replay', filter: { platform: 'facebook', limit: 10 }, dryRun: true },
      { ledger: ledger as never, producer: producer as never, out: (l) => lines.push(l) },
    );
    expect(code).toBe(0);
    expect(producer.replay).not.toHaveBeenCalled();
    expect(ledger.listDeadLetters).toHaveBeenCalledWith({
      platform: 'facebook',
      limit: 10,
      states: ['dead_lettered'],
    });
    expect(lines.at(-1)).toBe('{"wouldReplay":1}');
  });

  it('replays and reports the count', async () => {
    const lines: string[] = [];
    const producer = { replay: vi.fn(async () => [{ id: 'a' }, { id: 'b' }]) };
    const code = await runDlq(
      { cmd: 'replay', filter: { ids: [ORG], limit: 1 }, dryRun: false },
      { ledger: {} as never, producer: producer as never, out: (l) => lines.push(l) },
    );
    expect(code).toBe(0);
    expect(producer.replay).toHaveBeenCalledWith({ ids: [ORG], limit: 1 });
    expect(lines).toEqual(['{"replayed":2}']);
  });
});
