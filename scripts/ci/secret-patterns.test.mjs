import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findSecretLike } from './lib/secret-patterns.mjs';

test('placeholders are not secret-like', () => {
  assert.deepEqual(findSecretLike('set <APP_SECRET> and restart'), []);
});

test('Meta access tokens are secret-like', () => {
  assert.equal(findSecretLike('token EAA' + 'x'.repeat(40)).length, 1);
});
