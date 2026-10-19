import { describe, expect, it } from 'vitest';
import { renderDisableEmail } from './disable-email.js';

describe('renderDisableEmail', () => {
  it('renders the exact subject and text', () => {
    expect(
      renderDisableEmail({
        workspace: 'Acme',
        host: 'hooks.example.com',
        failures: 20,
        since: new Date('2026-10-01T12:00:00.000Z'),
        endpointId: '7d0c3f5e-6a51-4c55-9c8a-1f0b2a4d9e11',
      }),
    ).toEqual({
      subject: 'FeedBouncer webhook endpoint disabled',
      text: 'A webhook endpoint for hooks.example.com in Acme was disabled after 20 failed deliveries since 2026-10-01T12:00:00.000Z. FeedBouncer no longer sends events to it. To turn it back on, send PATCH /v1/webhook-endpoints/7d0c3f5e-6a51-4c55-9c8a-1f0b2a4d9e11 with {"status":"active"}. Deliveries cancelled when it was disabled can be redelivered for 30 days; events that occur while it is disabled are not recorded.',
    });
  });
});
