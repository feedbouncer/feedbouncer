import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/app-shell';
import { isUuid } from '@/lib/ids';
import { orgNav } from '@/lib/nav';

export default async function OrgLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  if (!isUuid(orgId)) notFound();
  return <AppShell nav={orgNav(orgId)}>{children}</AppShell>;
}
