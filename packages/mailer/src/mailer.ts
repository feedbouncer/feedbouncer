export interface OutboundEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly messageId?: string;
}

export interface Mailer {
  send(msg: OutboundEmail): Promise<void>;
}
