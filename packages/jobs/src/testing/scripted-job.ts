import { z } from 'zod';
import { ConnectorError } from '@feedbouncer/connectors';
import type { JobDefinition } from '../definition.js';

interface ScriptedPayload {
  ref: string;
  steps: string[];
}

/**
 * A job whose outcome is chosen by the payload. Run `i` of a ref executes
 * `steps[min(i, steps.length - 1)]`, so a test scripts a whole retry history.
 */
export class ScriptedJob {
  /** ref -> start timestamp of every run. */
  readonly runs = new Map<string, number[]>();
  /** ref -> number of times the "platform effect" actually happened. */
  readonly sideEffects = new Map<string, number>();
  readonly #waiters = new Map<string, () => void>();
  readonly #released = new Set<string>();

  /** Ends a `hang` step; also covers a release that arrives before the hang. */
  release(ref: string): void {
    this.#released.add(ref);
    this.#waiters.get(ref)?.();
  }

  #effect(ref: string): void {
    this.sideEffects.set(ref, (this.sideEffects.get(ref) ?? 0) + 1);
  }

  definition(): JobDefinition<ScriptedPayload> {
    return {
      type: 'scripted',
      platforms: 'all',
      timeoutMs: 10_000,
      payload: z.strictObject({
        ref: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
        steps: z.array(z.string()).min(1).max(20),
      }),
      externalRef: (p) => p.ref,
      handle: async (ctx, p) => {
        const starts = this.runs.get(p.ref) ?? [];
        const run = starts.length;
        starts.push(Date.now());
        this.runs.set(p.ref, starts);
        const step = p.steps[Math.min(run, p.steps.length - 1)]!;

        if (step === 'ok') {
          this.#effect(p.ref);
          return { status: 'ok' };
        }
        if (step === 'transient') throw new ConnectorError('transient', 'upstream_5xx');
        if (step.startsWith('rate:')) {
          throw new ConnectorError('rate_limited', 'throttled', {
            retryAfterMs: Number(step.slice('rate:'.length)),
          });
        }
        if (step === 'permanent') throw new ConnectorError('permanent', 'invalid_request');
        if (step === 'gone') throw new ConnectorError('not_found', 'comment_missing');
        if (step === 'reauth') {
          throw new ConnectorError('auth_expired', 'reauthorization_required', {
            reauthorize: true,
          });
        }
        if (step === 'hang') {
          await new Promise<void>((resolve) => {
            if (this.#released.has(p.ref) || ctx.signal.aborted) return resolve();
            this.#waiters.set(p.ref, resolve);
            ctx.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          this.#waiters.delete(p.ref);
          this.#released.delete(p.ref);
          this.#effect(p.ref);
          return { status: 'released' };
        }
        if (step === 'throw') throw new Error('boom token=SHOULD_NOT_LEAK');
        throw new Error(`unknown scripted step: ${step}`);
      },
    };
  }
}
