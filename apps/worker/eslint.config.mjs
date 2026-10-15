import baseConfig, { restrictProcessEnv } from '../../eslint.config.base.mjs';

export default [
  ...baseConfig,
  restrictProcessEnv({
    // enqueue-selftest is a standalone operator tool that needs only REDIS_URL (validated with
    // readUrl); requiring the full worker secrets would regress it. Exempt that file only, so a
    // new CLI must go through loadWorkerEnv() or be added here deliberately.
    exempt: ['src/main.ts', 'src/cli/enqueue-selftest.ts', 'src/cli/jobs.ts', 'src/**/*.test.ts'],
    message: 'Read configuration only via loadWorkerEnv() in main.ts (single typed config layer).',
  }),
];
