export interface OutboundEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export interface Mailer {
  send(msg: OutboundEmail): Promise<void>;
}

/** Collects messages instead of sending them. For tests. */
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
