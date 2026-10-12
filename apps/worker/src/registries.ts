import { ConnectorRegistry } from '@feedbouncer/connectors';
import { JobRegistry } from '@feedbouncer/jobs';

/** Platform connectors this deployment runs. Each registered platform gets its own queue. */
export function buildConnectorRegistry(): ConnectorRegistry {
  return new ConnectorRegistry();
}

/** Job types the worker executes. See docs/jobs/defining-a-job.md. */
export function buildJobRegistry(): JobRegistry {
  return new JobRegistry();
}
