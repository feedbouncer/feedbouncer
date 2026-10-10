import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from './logger.js';
import { onShutdown } from './shutdown.js';

function fakeProcess() {
  const emitter = new EventEmitter();
  const exit = vi.fn();
  return { proc: Object.assign(emitter, { exit }), exit };
}
const log = createLogger('test', 'error', () => {});
const flush = () => new Promise((r) => setImmediate(r));

describe('onShutdown', () => {
  it('runs cleanup once on SIGTERM, then exits 0', async () => {
    const { proc, exit } = fakeProcess();
    const cleanup = vi.fn(async () => {});
    onShutdown(cleanup, log, proc);
    proc.emit('SIGTERM');
    await flush();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits 1 when cleanup fails', async () => {
    const { proc, exit } = fakeProcess();
    onShutdown(() => Promise.reject(new Error('x')), log, proc);
    proc.emit('SIGINT');
    await flush();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('a second signal during cleanup forces exit 1 without re-running cleanup', async () => {
    const { proc, exit } = fakeProcess();
    const cleanup = vi.fn(() => new Promise<void>(() => {}));
    onShutdown(cleanup, log, proc);
    proc.emit('SIGTERM');
    proc.emit('SIGTERM');
    await flush();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
