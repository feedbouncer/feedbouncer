import baseConfig, { restrictProcessEnv } from '../../eslint.config.base.mjs';

export default [
  ...baseConfig,
  restrictProcessEnv({
    exempt: ['src/**/*.test.ts'],
    message:
      'The reports package receives configuration from the app; never read process.env here.',
  }),
];
