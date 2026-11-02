import { notFound } from 'next/navigation';
import { ApiForm } from '../../../../components/api-form';
import { InviteForm } from '../../../../components/invite-form';
import { ReplyGrantToggle } from '../../../../components/reply-grant-toggle';
import { Card, CardContent, CardHeader, CardTitle } from '../../../../components/ui/card';
import { ListPanel, ListRow } from '../../../../components/ui/list';
import { PageHeader } from '../../../../components/ui/page-header';
import { isUuid } from '../../../../lib/ids';
import { dataOrThrow, requireMe, serverGet, type Role } from '../../../../lib/server-api';

interface Member {
  userId: string;
  email: string;
  name: string | null;
  role: Role;
}
interface Invitation {
  id: string;
  email: string;
  role: Role;
  expired: boolean;
}

const ROLES: readonly Role[] = ['owner', 'admin', 'member'];

export default async function MembersPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  if (!isUuid(orgId)) notFound();
  const me = await requireMe(`/orgs/${orgId}/members`);
  const org = await serverGet<{ role: Role }>(`/api/v1/orgs/${orgId}`);
  const members = await serverGet<{ members: Member[] }>(`/api/v1/orgs/${orgId}/members`);
  const orgData = dataOrThrow(org, 'organization');
  const memberData = dataOrThrow(members, 'members');
  const viewer = orgData.role;
  const manager = viewer !== 'member';
  const grantable = viewer === 'owner' ? ROLES : ROLES.filter((r) => r !== 'owner');
  const invitationList = manager
    ? dataOrThrow(
        await serverGet<{ invitations: Invitation[] }>(`/api/v1/orgs/${orgId}/invitations`),
        'invitations',
      ).invitations
    : [];
  const grants = dataOrThrow(
    await serverGet<{ grants: { role: Role; capability: string }[] }>(
      `/api/v1/orgs/${orgId}/role-grants`,
    ),
    'role grants',
  ).grants;
  const membersReply = grants.some((g) => g.role === 'member' && g.capability === 'comment.reply');
  const candidates = memberData.members
    .filter((m) => m.userId !== me.user.id)
    .map((m) => ({ value: m.userId, label: m.email }));
  const base = `/api/v1/orgs/${orgId}` as const;
  return (
    <main>
      <PageHeader title="Members" />
      <ListPanel>
        {memberData.members.map((m) => {
          const editable = manager && (viewer === 'owner' || m.role !== 'owner');
          return (
            <ListRow key={m.userId} className="flex-col items-stretch sm:flex-row sm:items-center">
              <div className="flex flex-col gap-0.5">
                <span className="font-semibold text-foreground">
                  {m.email}
                  {m.name ? ` (${m.name})` : ''}
                </span>
                <span className="text-small text-dim capitalize">{m.role}</span>
              </div>
              {editable ? (
                <div className="flex flex-wrap items-start gap-3">
                  <ApiForm
                    action={`${base}/members/${m.userId}`}
                    method="PATCH"
                    fields={[
                      {
                        name: 'role',
                        label: 'Role',
                        type: 'select',
                        options: grantable,
                        defaultValue: m.role,
                      },
                    ]}
                    submitLabel="Save"
                    layout="inline"
                    size="sm"
                    refresh
                    className="w-40"
                  />
                  <ApiForm
                    action={`${base}/members/${m.userId}`}
                    method="DELETE"
                    fields={[]}
                    submitLabel="Remove"
                    variant="destructive"
                    size="sm"
                    refresh
                    className="self-end"
                  />
                </div>
              ) : null}
            </ListRow>
          );
        })}
      </ListPanel>

      <Card>
        <CardHeader>
          <CardTitle>Permissions</CardTitle>
        </CardHeader>
        <CardContent>
          <ReplyGrantToggle orgId={orgId} granted={membersReply} canChange={manager} />
        </CardContent>
      </Card>

      {manager ? (
        <section>
          <h2>Invitations</h2>
          {invitationList.length > 0 ? (
            <ListPanel>
              {invitationList.map((i) => (
                <ListRow key={i.id}>
                  <span>
                    {i.email} <span className="text-dim capitalize">· {i.role}</span>
                    {i.expired ? <span className="text-dim"> · expired</span> : null}
                  </span>
                  <ApiForm
                    action={`${base}/invitations/${i.id}/revoke`}
                    fields={[]}
                    submitLabel="Revoke"
                    variant="destructive"
                    size="sm"
                    refresh
                  />
                </ListRow>
              ))}
            </ListPanel>
          ) : (
            <p data-state="empty">No pending invitations.</p>
          )}
          <Card>
            <CardHeader>
              <CardTitle>Invite someone</CardTitle>
            </CardHeader>
            <CardContent>
              <InviteForm action={`${base}/invitations`} roles={grantable} />
            </CardContent>
          </Card>
        </section>
      ) : null}

      {viewer === 'owner' && candidates.length > 0 ? (
        <Card className="border-danger/40">
          <CardHeader>
            <CardTitle>Transfer ownership</CardTitle>
          </CardHeader>
          <CardContent>
            <ApiForm
              action={`${base}/transfer-ownership`}
              fields={[
                {
                  name: 'userId',
                  label: 'New owner',
                  type: 'select',
                  options: candidates,
                },
                {
                  name: 'newRoleForSelf',
                  label: 'Your role afterwards',
                  type: 'select',
                  options: ['admin', 'member'],
                },
              ]}
              submitLabel="Transfer ownership"
              variant="destructive"
              refresh
            />
          </CardContent>
        </Card>
      ) : null}

      <Card className="border-danger/40">
        <CardHeader>
          <CardTitle>Leave organization</CardTitle>
        </CardHeader>
        <CardContent>
          <ApiForm
            action={`${base}/members/${me.user.id}`}
            method="DELETE"
            fields={[]}
            submitLabel="Leave organization"
            variant="destructive"
            redirectTo="/orgs"
          />
        </CardContent>
      </Card>
    </main>
  );
}
