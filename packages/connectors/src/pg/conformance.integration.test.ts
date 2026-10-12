import { afterAll } from 'vitest';
import { runConnectorConformance } from '../testing/index.js';
import { closePgHarnessDatabase, createPgHarness } from '../testing/pg-harness.js';

afterAll(closePgHarnessDatabase);

runConnectorConformance('reference push over Postgres + Redis', () => createPgHarness('push'), {
  realTime: true,
});
runConnectorConformance('reference poll over Postgres + Redis', () => createPgHarness('poll'), {
  realTime: true,
});
