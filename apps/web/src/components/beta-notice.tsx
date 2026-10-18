import { readBetaConfig } from '../lib/beta';

export function BetaNotice() {
  const { feedbackUrl, supportEmail } = readBetaConfig();
  if (!feedbackUrl && !supportEmail) return null;
  return (
    <p>
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
