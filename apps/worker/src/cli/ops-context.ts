import type { createPool } from '@feedbouncer/db';
import type { JobProducer } from '@feedbouncer/jobs';
import type { Env, Logger } from '@feedbouncer/service-runtime';

export type Pool = ReturnType<typeof createPool>;

/** What an operator command may use. Connections open on first use and close when the command ends. */
export interface OpsContext {
  readonly log: Logger;
  readonly env: Env;
  /** Where the operator ran pnpm from; `pnpm ops` itself runs in apps/worker. */
  readonly cwd: string;
  readonly out: (line: string) => void;
  pool(): Pool;
  producer(): JobProducer;
}

export type OpsCommand = (argv: readonly string[], ctx: OpsContext) => Promise<number>;
