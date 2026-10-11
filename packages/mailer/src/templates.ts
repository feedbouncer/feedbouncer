import type { OutboundEmail } from './mailer.js';

type Body = Omit<OutboundEmail, 'to'>;

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);

// Control characters (CR/LF included) become spaces so a value can never add a header.
export const headerSafe = (s: string, max = 150): string =>
  s
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, max);

function page(title: string, paragraphs: string[], cta: { label: string; url: string }): string {
  const ps = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('');
  return `<!doctype html><html><body><h1>${escapeHtml(title)}</h1>${ps}<p><a href="${escapeHtml(cta.url)}">${escapeHtml(cta.label)}</a></p></body></html>`;
}

export function renderVerifyEmail(url: string): Body {
  const intro =
    'Confirm your email address to finish setting up your FeedBouncer account. The link expires in 24 hours.';
  return {
    subject: 'Confirm your email for FeedBouncer',
    text: `${intro}\n\n${url}\n`,
    html: page('Confirm your email', [intro], { label: 'Confirm email', url }),
  };
}

export function renderPasswordReset(url: string): Body {
  const intro =
    'Someone asked to reset your FeedBouncer password. The link works once and expires in 1 hour. If this was not you, ignore this email.';
  return {
    subject: 'Reset your FeedBouncer password',
    text: `${intro}\n\n${url}\n`,
    html: page('Reset your password', [intro], { label: 'Reset password', url }),
  };
}

export function renderAccountExists(loginUrl: string, resetUrl: string): Body {
  const intro =
    'Someone tried to create a FeedBouncer account with this email, but you already have one. Log in, or reset your password if you forgot it.';
  return {
    subject: 'You already have a FeedBouncer account',
    text: `${intro}\n\nLog in: ${loginUrl}\nReset password: ${resetUrl}\n`,
    html: page('You already have an account', [intro, `Forgot your password? ${resetUrl}`], {
      label: 'Log in',
      url: loginUrl,
    }),
  };
}

export function renderInvitation(p: {
  organizationName: string;
  inviterName: string | null;
  role: string;
  url: string;
}): Body {
  const org = headerSafe(p.organizationName);
  const inviter = p.inviterName ? headerSafe(p.inviterName) : '';
  const who = inviter ? `${inviter} invited you` : 'You have been invited';
  const intro = `${who} to join ${org} on FeedBouncer as ${p.role}. The invitation expires in 7 days.`;
  return {
    subject: `Join ${org} on FeedBouncer`,
    text: `${intro}\n\n${p.url}\n`,
    html: page(`Join ${org}`, [intro], { label: 'Accept invitation', url: p.url }),
  };
}

/** Test helper: the first http(s) URL in a text body. */
export function extractFirstUrl(text: string): string | null {
  return /https?:\/\/[^\s"<>]+/.exec(text)?.[0] ?? null;
}
