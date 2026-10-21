import { Injectable } from '@nestjs/common';
import type { Capability } from '@feedbouncer/authz';
import { OrgAccessGuard, type OrgContext } from '../tenancy/org-access.guard.js';
import { recordPrivacyDenial } from './denial.js';

/** The org access check for privacy routes, which also audits each refusal. */
@Injectable()
export class PrivacyAccessGuard extends OrgAccessGuard {
  protected override onDenied = (org: OrgContext, capability: Capability, route: string) =>
    recordPrivacyDenial(this.deps, org, capability, route);
}
