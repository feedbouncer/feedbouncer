import { connection } from 'next/server';
import { readBetaConfig } from '../lib/beta';

// Reads the environment per request, so the notice follows runtime configuration.
export async function BetaNotice() {
  await connection();
  const { feedbackUrl, supportEmail } = readBetaConfig();
  if (!feedbackUrl && !supportEmail) return null;
  return (
    <p className="border-b border-border bg-elevated px-4 py-2 text-center text-small text-dim">
      FeedBouncer private beta.{' '}
      {feedbackUrl ? (
        <a href={feedbackUrl} rel="noopener noreferrer">
          Send feedback
        </a>
      ) : null}
      {feedbackUrl && supportEmail ? ' · ' : null}
      {supportEmail ? <a href={`mailto:${supportEmail}`}>Email support</a> : null}
    </p>
  );
}
