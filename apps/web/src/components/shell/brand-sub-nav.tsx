'use client';

import { usePathname } from 'next/navigation';
import { isUuid } from '../../lib/ids';
import { brandNav } from '../../lib/nav';
import { NavLinks } from './nav-links';

const BRAND_PATH = /^\/orgs\/([^/]+)\/brands\/([^/]+)/;

export function BrandSubNav() {
  const match = BRAND_PATH.exec(usePathname());
  if (!match || !isUuid(match[1]!) || !isUuid(match[2]!)) return null;
  return <NavLinks label="Brand" items={brandNav(match[1]!, match[2]!)} variant="secondary" />;
}
