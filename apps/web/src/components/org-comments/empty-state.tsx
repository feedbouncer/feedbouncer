import Link from 'next/link';

export function EmptyState({
  kind,
  orgId,
  canManage,
}: {
  kind: 'no_accounts' | 'no_comments' | 'no_match';
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
