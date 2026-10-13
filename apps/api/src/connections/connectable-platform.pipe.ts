import { Inject, Injectable, type PipeTransform } from '@nestjs/common';
import { isPlatform, type Platform } from '@feedbouncer/connectors';
import type { AppDeps } from '../deps.js';
import { ApiError } from '../http/errors.js';
import { DEPS } from '../tokens.js';

/**
 * Resolves the `:platform` path segment of the connect flow. Only a registered
 * connector that lets the user pick accounts after consent can be connected
 * here; anything else, including a platform that exists but is switched off,
 * is 404 platform_not_configured.
 */
@Injectable()
export class ConnectablePlatformPipe implements PipeTransform<unknown, Platform> {
  constructor(@Inject(DEPS) private readonly deps: AppDeps) {}

  transform(value: unknown): Platform {
    if (
      isPlatform(value) &&
      this.deps.connectors?.registry.get(value)?.capabilities.accountSelection === 'multiple'
    )
      return value;
    throw new ApiError(404, 'platform_not_configured');
  }
}
