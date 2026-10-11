import baseConfig from '../../eslint.config.base.mjs';

export default [
  ...baseConfig,
  {
    files: ['src/**/*.ts'],
    ignores: ['src/main.ts', 'src/cli/**', 'src/**/*.test.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'Read configuration only via loadWorkerEnv() in main.ts (single typed config layer). CLI entry points under src/cli are exempt because they are standalone processes.',
        },
      ],
    },
  },
];
