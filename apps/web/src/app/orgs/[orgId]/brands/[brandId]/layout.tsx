import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { isUuid } from '../../../../../lib/ids';

export default async function BrandLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ orgId: string; brandId: string }>;
}) {
  const { orgId, brandId } = await params;
  if (!isUuid(orgId) || !isUuid(brandId)) notFound();
  return children;
}
