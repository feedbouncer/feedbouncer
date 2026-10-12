import { describe, expect, it } from 'vitest';
import { installCrashHandlers, type CrashProcess } from './crash.js';
import { createLogger } from './logger.js';

function fakeProcess() {
  const listeners = new Map<string, (err: unknown) => void>();
  const exits: number[] = [];
  const proc: CrashProcess = {
    on: (event, listener) => listeners.set(event, listener),
    exit: (code) => {
      exits.push(code);
    },
  };
  return { proc, listeners, exits };
}

describe('installCrashHandlers', () => {
  it('logs a redacted error line and exits 1 on uncaught exceptions and rejections', () => {
    for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
      const lines: string[] = [];
      const { proc, listeners, exits } = fakeProcess();
      installCrashHandlers(
        createLogger('t', 'debug', (l) => lines.push(l)),
        proc,
      );
      listeners.get(event)!(new Error('refresh failed for token=abcdef123456 at https://u:pw@h/x'));
      expect(exits).toEqual([1]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain('abcdef123456');
      expect(lines[0]).not.toContain(':pw@');
      expect(lines[0]).not.toContain('"stack"');
    }
  });
});
