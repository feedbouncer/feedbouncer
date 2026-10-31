import { isUuid } from '@/lib/ids';

export interface NavItem {
  href: string;
  label: string;
  exact?: boolean;
}

const ORG_SECTIONS: [label: string, slug: string][] = [
  ['Comments', 'comments'],
  ['Reports', 'reports'],
  ['Alerts', 'alerts'],
  ['Members', 'members'],
  ['Tags', 'tags'],
  ['API keys', 'api-keys'],
];

const BRAND_SECTIONS = [
  'Comments',
  'Review',
  'Suggestions',
  'Rules',
  'Policies',
  'Classifier',
  'Actions',
  'Ads',
  'Alerts',
  'Domains',
  'Connections',
];

function assertIds(...ids: string[]): void {
  if (!ids.every(isUuid)) throw new Error('invalid id');
}

export function orgNav(orgId: string): NavItem[] {
  assertIds(orgId);
  const base = `/orgs/${orgId}`;
  return [
    { href: base, label: 'Overview', exact: true },
    ...ORG_SECTIONS.map(([label, slug]) => ({ href: `${base}/${slug}`, label })),
  ];
}

export function brandNav(orgId: string, brandId: string): NavItem[] {
  assertIds(orgId, brandId);
  const base = `/orgs/${orgId}/brands/${brandId}`;
  return BRAND_SECTIONS.map((label) => ({ href: `${base}/${label.toLowerCase()}`, label }));
}

export function isActive(pathname: string, item: NavItem): boolean {
  const path = (pathname.split(/[?#]/)[0] ?? '').replace(/\/+$/, '');
  return path === item.href || (!item.exact && path.startsWith(item.href + '/'));
}
