import baseConfig, { restrictProcessEnv } from '../../eslint.config.base.mjs';

export default [
  ...baseConfig,
  restrictProcessEnv({
    exempt: ['src/bin.ts', 'src/**/*.test.ts'],
    message: 'Only bin.ts reads process.env; pass env into main().',
  }),
];
