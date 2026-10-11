import nodemailer from 'nodemailer';
import { headerSafe } from './templates.js';
import type { Mailer, OutboundEmail } from './mailer.js';

// One bare address: no list separators, display names or quoting that nodemailer would parse.
const RECIPIENT = /^[^\s@,;<>"]+@[^\s@,;<>"]+$/;

export function createSmtpMailer(smtpUrl: URL, from: string): Mailer & { close(): void } {
  const transport = nodemailer.createTransport(smtpUrl.href);
  return {
    async send(msg: OutboundEmail): Promise<void> {
      // Validate before anything reaches nodemailer. The address is left out of
      // the message so it does not end up in logs.
      if (!RECIPIENT.test(msg.to)) throw new Error('invalid recipient');
      try {
        await transport.sendMail({
          from,
          to: msg.to,
          subject: headerSafe(msg.subject),
          text: msg.text,
          html: msg.html,
        });
      } catch (cause) {
        throw new Error('smtp send failed', { cause });
      }
    },
    close(): void {
      transport.close();
    },
  };
}
