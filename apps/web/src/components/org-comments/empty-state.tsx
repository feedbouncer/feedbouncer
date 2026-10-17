import Link from 'next/link';

export function EmptyState({
  kind,
  orgId,
  canManage,
}: {
  kind: 'no_accounts' | 'no_comments' | 'no_match' | 'no_open' | 'no_done';
  orgId: string;
  canManage: boolean;
}) {
  if (kind === 'no_match')
    return (
      <section>
        <h2>No comments match these filters</h2>
        <p>
          <Link href={`/orgs/${orgId}/comments`}>Clear filters</Link>
        </p>
      </section>
    );
  if (kind === 'no_open')
    return (
      <section>
        <h2>No open comments</h2>
        <p>
          <Link href={`/orgs/${orgId}/comments?queue=done`}>Show done comments</Link>
        </p>
      </section>
    );
  if (kind === 'no_done')
    return (
      <section>
        <h2>No done comments</h2>
      </section>
    );
  if (kind === 'no_comments')
    return (
      <section>
        <h2>No comments yet</h2>
        <p>New comments on your connected accounts will appear here.</p>
      </section>
    );
  return (
    <section>
      <h2>Connect an account to see comments</h2>
      <p>FeedBouncer shows comments from the accounts you connect.</p>
      <p>
        {canManage ? (
          <Link href={`/orgs/${orgId}`}>Connect an account</Link>
        ) : (
          'Ask an admin to connect an account.'
        )}
      </p>
    </section>
  );
}
