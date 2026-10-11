import { SetMetadata } from '@nestjs/common';
import type { Capability } from '@feedbouncer/authz';

export const CAPABILITY = 'fb:capability';
export const RequireCapability = (cap: Capability) => SetMetadata(CAPABILITY, cap);
