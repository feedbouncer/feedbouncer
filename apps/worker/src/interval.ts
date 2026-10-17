import { errorFields, type Logger } from '@feedbouncer/service-runtime';

/** Runs `tick` every `intervalMs`, skipping a beat while the previous tick is still running. */
export function every(
  loop: string,
  intervalMs: number,
  tick: () => Promise<unknown>,
  log: Logger,
  failedEvent: string,
): NodeJS.Timeout {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    tick()
      .catch((err: unknown) => log.error(failedEvent, { loop, ...errorFields(err) }))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return timer;
}
