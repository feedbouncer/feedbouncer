import baseConfig, { restrictProcessEnv } from '../../eslint.config.base.mjs';

export default [
  ...baseConfig,
  restrictProcessEnv({
    // src/testing is test-only support code (integration harness reads REDIS_URL/DATABASE_URL).
    exempt: ['src/main.ts', 'src/testing/**', 'src/**/*.test.ts'],
    message: 'Read configuration only via loadApiEnv() in main.ts (single typed config layer).',
  }),
];
