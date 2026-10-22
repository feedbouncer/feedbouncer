import baseConfig from '../../eslint.config.base.mjs';

export default [
  {
    ignores: [
      'test-results/**',
      'playwright-report/**',
      '.docusaurus/**',
      'build/**',
      'docs/_generated/**',
      'docs/api/reference/**',
    ],
  },
  ...baseConfig,
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly' } },
  },
];
