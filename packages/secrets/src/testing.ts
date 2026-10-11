// Throwaway keys for tests. Never use outside tests.
import { randomBytes } from 'node:crypto';
import { Keyring } from './keyring.js';

export function randomKeyEntry(id: string): string {
  return `${id}:${randomBytes(32).toString('base64')}`;
}

export function testKeyring(ids: string[] = ['test-a'], active: string = ids[0]!): Keyring {
  return new Keyring(new Map(ids.map((id) => [id, randomBytes(32)])), active);
}
