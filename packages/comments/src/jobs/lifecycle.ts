// Platform-side setup after a (re)connect and cleanup after a disconnect.
// Teardown always ends with the stored secrets deleted, even when the platform
// never confirmed the unsubscribe: a failed unsubscribe is dead-lettered (and so
// visible in health) only after the secrets are gone.
import { ConnectorError, type ConnectorRuntime } from '@feedbouncer/connectors';
import { classifyFailure, type JobDefinition } from '@feedbouncer/jobs';
import type { CredentialStore } from '@feedbouncer/secrets';
import type { Logger } from '@feedbouncer/service-runtime';
import { LIFECYCLE_JOB, type LifecyclePayload } from './specs.js';

const retryable = (err: unknown) => {
  const k = classifyFailure(err).kind;
  return k === 'retryable' || k === 'rate_limited';
};

export function connectionLifecycleJob(d: {
  runtime: ConnectorRuntime;
  credentials: CredentialStore;
  log: Logger;
}): JobDefinition<LifecyclePayload> {
  const maxAttempts = LIFECYCLE_JOB.policy.maxAttempts;
  return {
    ...LIFECYCLE_JOB,
    handle: async (ctx, p) => {
      const { scope } = ctx;
      if (p.op === 'setup') {
        await (await d.runtime.connect(scope)).setup();
        return { op: 'setup' };
      }
      let failure: unknown = null;
      try {
        await d.runtime.teardown(scope);
      } catch (err) {
        // Reconnected before this ran: the credentials belong to the live connection now.
        if (err instanceof ConnectorError && err.code === 'connection_not_revoked')
          return { op: 'teardown', skipped: 'connection_not_revoked' };
        if (retryable(err) && ctx.attempt < maxAttempts) throw err;
        failure = err;
      }
      await d.credentials.delete(scope);
      const unsubscribed = failure === null;
      d.log.info('connection.teardown_finished', {
        connectionId: scope.connectionId,
        unsubscribed,
      });
      if (failure !== null) throw failure;
      return { op: 'teardown', unsubscribed };
    },
  };
}
