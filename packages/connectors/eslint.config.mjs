import baseConfig, { restrictProcessEnv } from '../../eslint.config.base.mjs';

export default [
  ...baseConfig,
  restrictProcessEnv({
    exempt: ['src/**/*.test.ts', 'src/testing/pg-harness.ts'],
    message: 'Connectors receive configuration from the app; never read process.env here.',
  }),
];
