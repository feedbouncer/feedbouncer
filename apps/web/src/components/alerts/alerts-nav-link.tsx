import { can } from '@feedbouncer/authz';
import Link from 'next/link';
import type { Role } from '../../lib/server-api';

/** The Alerts link, only for roles that may read alerts. */
export function AlertsNavLink({ role, href }: { role: Role; href: string }) {
  return can(role, 'alert.read') ? <Link href={href}>Alerts</Link> : null;
}
