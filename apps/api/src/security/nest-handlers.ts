import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { DiscoveryService, MetadataScanner, ModulesContainer, Reflector } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

const join = (...parts: string[]) =>
  '/' +
  parts
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');

export interface NestHandler {
  /** "METHOD /path" as declared on the controller. */
  route: string;
  label: string;
  handler: () => unknown;
}

/** Every Nest controller handler with its declared method and full path. */
export function nestHandlers(app: NestFastifyApplication): NestHandler[] {
  const reflector = new Reflector();
  const discovery = new DiscoveryService(app.get(ModulesContainer, { strict: false }));
  const scanner = new MetadataScanner();
  const out: NestHandler[] = [];
  for (const wrapper of discovery.getControllers()) {
    const instance = wrapper.instance as object | undefined;
    if (!instance) continue;
    const proto = Object.getPrototypeOf(instance) as object;
    const base = reflector.get<string | undefined>(PATH_METADATA, wrapper.metatype as never) ?? '';
    for (const name of scanner.getAllMethodNames(proto)) {
      const handler = (proto as Record<string, unknown>)[name] as () => unknown;
      const sub = reflector.get<string | undefined>(PATH_METADATA, handler);
      const method = reflector.get<number | undefined>(METHOD_METADATA, handler);
      if (sub === undefined || method === undefined) continue;
      const full = join(String(base), sub);
      out.push({
        route: `${RequestMethod[method]} ${full}`,
        label: `${RequestMethod[method]} ${full} (${wrapper.name}.${name})`,
        handler,
      });
    }
  }
  return out;
}
