import baseConfig, { restrictProcessEnv } from '../../eslint.config.base.mjs';

export default [
  ...baseConfig,
  restrictProcessEnv({
    exempt: ['src/bin.ts', 'src/**/*.test.ts', 'src/testing/db.ts', 'src/testing/redis.ts'],
    message: 'The jobs package receives configuration from the app; never read process.env here.',
  }),
];
