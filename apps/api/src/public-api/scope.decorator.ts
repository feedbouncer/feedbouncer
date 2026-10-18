import { SetMetadata } from '@nestjs/common';
import type { ApiKeyScope } from '@feedbouncer/public-api';

export const API_SCOPE = 'fb:api-scope';
export const RequireScope = (scope: ApiKeyScope) => SetMetadata(API_SCOPE, scope);
