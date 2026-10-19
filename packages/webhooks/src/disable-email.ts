import { RETENTION_DAYS } from './constants.js';

export function renderDisableEmail(i: {
  workspace: string;
  host: string;
  failures: number;
  since: Date;
  endpointId: string;
}): { subject: string; text: string } {
  return {
    subject: 'FeedBouncer webhook endpoint disabled',
    text:
      `A webhook endpoint for ${i.host} in ${i.workspace} was disabled after ${i.failures} failed deliveries since ${i.since.toISOString()}. ` +
      'FeedBouncer no longer sends events to it. ' +
      `To turn it back on, send PATCH /v1/webhook-endpoints/${i.endpointId} with {"status":"active"}. ` +
      `Deliveries cancelled when it was disabled can be redelivered for ${RETENTION_DAYS} days; events that occur while it is disabled are not recorded.`,
  };
}
