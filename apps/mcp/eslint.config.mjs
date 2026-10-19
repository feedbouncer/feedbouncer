import baseConfig, { restrictProcessEnv } from '../../eslint.config.base.mjs';

export default [
  ...baseConfig,
  restrictProcessEnv({
    exempt: ['src/config.ts', 'src/**/*.test.ts'],
    message: 'Read configuration only via loadConfig() in config.ts (single typed config layer).',
  }),
];
