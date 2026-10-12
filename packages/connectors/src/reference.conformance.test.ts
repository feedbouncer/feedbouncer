import { createInMemoryHarness, runConnectorConformance } from './testing/index.js';

runConnectorConformance('reference push (webhooks, rotating tokens, all actions)', () =>
  createInMemoryHarness('push'),
);
runConnectorConformance('reference poll (polling only, non-rotating, hide+delete)', () =>
  createInMemoryHarness('poll'),
);
