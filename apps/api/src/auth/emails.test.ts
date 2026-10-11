import { describe, expect, it } from 'vitest';
import type { Mailer } from '@feedbouncer/mailer';
import { MemoryMailer } from '@feedbouncer/mailer/testing';
import { createLogger } from '@feedbouncer/service-runtime';
import { createAuthEmails } from './emails.js';

const WEB = 'https://app.example.test';
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(mailer: Mailer) {
  const lines: string[] = [];
  const emails = createAuthEmails(
    mailer,
    createLogger('test', 'debug', (l) => lines.push(l)),
    WEB,
  );
  return { emails, lines };
}

describe('createAuthEmails', () => {
  it('sends each kind to the recipient with its link', async () => {
    const mailer = new MemoryMailer();
    const { emails } = setup(mailer);
    emails.verify('a@x.test', `${WEB}/api/auth/verify-email?token=v1`);
    emails.passwordReset('b@x.test', `${WEB}/api/auth/reset-password/r1`);
    emails.accountExists('c@x.test');
    emails.invitation('d@x.test', {
      organizationName: 'Acme',
      inviterName: 'Ana',
      role: 'admin',
      token: 'a b/c',
    });
    await flush();
    expect(mailer.lastTo('a@x.test')!.text).toContain(`${WEB}/api/auth/verify-email?token=v1`);
    expect(mailer.lastTo('b@x.test')!.text).toContain(`${WEB}/api/auth/reset-password/r1`);
    expect(mailer.lastTo('c@x.test')!.text).toContain(`${WEB}/login`);
    expect(mailer.lastTo('c@x.test')!.text).toContain(`${WEB}/forgot-password`);
    const invite = mailer.lastTo('d@x.test')!;
    expect(invite.text).toContain(`${WEB}/invite?token=a%20b%2Fc`);
    expect(invite.text).toContain('Ana invited you to join Acme');
  });

  it('does not wait for or fail on the mailer, and logs failures without the link', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const failing: Mailer = {
      send: async () => {
        await gate;
        throw new Error('smtp down');
      },
    };
    const { emails, lines } = setup(failing);
    expect(() =>
      emails.passwordReset('b@x.test', `${WEB}/api/auth/reset-password/SECRET1`),
    ).not.toThrow();
    release();
    await flush();
    await flush();
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(line).toMatchObject({ level: 'warn', msg: 'email send failed', kind: 'password_reset' });
    expect(lines[0]).not.toContain('SECRET1');
    expect(lines[0]).not.toContain('b@x.test');
  });
});
