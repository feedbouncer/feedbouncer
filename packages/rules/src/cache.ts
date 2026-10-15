import type { BrandScope } from '@feedbouncer/comments';
import { compileRuleSet, type CompiledRuleSet } from './engine.js';
import type { PgRuleStore } from './store.js';

const DEFAULT_MAX_BRANDS = 500;
export const CACHE_TTL_MS = 60_000;

interface Entry {
  version: string;
  set: CompiledRuleSet;
  loadedAt: number;
}

/**
 * Per-brand cache of compiled rule sets, validated against the store's
 * revision counter on every get. Entries also expire after 60 s as a backstop.
 */
export class RuleSetCache {
  readonly #store: Pick<PgRuleStore, 'version' | 'loadActive'>;
  readonly #max: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, Entry>(); // insertion order = LRU order
  readonly #inflight = new Map<string, Promise<CompiledRuleSet>>();

  constructor(
    store: Pick<PgRuleStore, 'version' | 'loadActive'>,
    opts: { maxBrands?: number; now?: () => number } = {},
  ) {
    this.#store = store;
    this.#max = opts.maxBrands ?? DEFAULT_MAX_BRANDS;
    this.#now = opts.now ?? Date.now;
  }

  async get(scope: BrandScope): Promise<CompiledRuleSet> {
    const key = `${scope.organizationId}:${scope.brandId}`;
    const version = await this.#store.version(scope);
    const hit = this.#entries.get(key);
    if (hit && hit.version === version && this.#now() - hit.loadedAt < CACHE_TTL_MS) {
      this.#entries.delete(key);
      this.#entries.set(key, hit);
      return hit.set;
    }
    const flightKey = `${key}|${version}`;
    const running = this.#inflight.get(flightKey);
    if (running) return running;
    const p = this.#compile(scope, key).finally(() => this.#inflight.delete(flightKey));
    this.#inflight.set(flightKey, p);
    return p;
  }

  async #compile(scope: BrandScope, key: string): Promise<CompiledRuleSet> {
    const loaded = await this.#store.loadActive(scope);
    const set = compileRuleSet(loaded.records, { ownDomains: loaded.ownDomains }, loaded.version);
    this.#entries.delete(key);
    this.#entries.set(key, { version: loaded.version, set, loadedAt: this.#now() });
    while (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next().value as string;
      this.#entries.delete(oldest);
    }
    return set;
  }
}
