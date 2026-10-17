import Link from 'next/link';
import { noticeText, type AccountHealthDto } from '../../lib/org-comments';

export function AccountNotices({
  orgId,
  accounts,
  canManage,
}: {
  orgId: string;
  accounts: AccountHealthDto[];
  canManage: boolean;
}) {
  return accounts.map((a) => {
    const text = noticeText(a);
    if (text === null) return null;
    return (
      <p key={a.connectionId} role="status">
        {text}
        {a.problem === 'reconnect_required' ? (
          canManage ? (
            <>
              {' '}
              <Link href={`/orgs/${orgId}/brands/${a.brandId}/connections`}>Reconnect</Link>
            </>
          ) : (
            ' Ask an admin to reconnect it.'
          )
        ) : null}
      </p>
    );
  });
}
