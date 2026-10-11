// Test helpers. Exported as @feedbouncer/mailer/testing, not from the package
// entry point, so production code cannot pick them up by accident.
import type { Mailer, OutboundEmail } from './mailer.js';

/** Collects messages instead of sending them. */
export class MemoryMailer implements Mailer {
  readonly sent: OutboundEmail[] = [];

  send(m: OutboundEmail): Promise<void> {
    this.sent.push(m);
    return Promise.resolve();
  }

  /** The most recent message to this address (case-insensitive). */
  lastTo(to: string): OutboundEmail | undefined {
    const wanted = to.toLowerCase();
    return this.sent.findLast((m) => m.to.toLowerCase() === wanted);
  }

  clear(): void {
    this.sent.length = 0;
  }
}

/** The first http(s) URL in a text body. */
export function extractFirstUrl(text: string): string | null {
  return /https?:\/\/[^\s"<>]+/.exec(text)?.[0] ?? null;
}
