import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import turboPlugin from 'eslint-plugin-turbo';
import eslintConfigPrettier from 'eslint-config-prettier';

export default [
  {
    ignores: [
      '**/.venv/**',
      '**/.pytest_cache/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/.turbo/**',
    ],
  },
  { files: ['**/*.{js,mjs,cjs}'], ...js.configs.recommended },
  ...tseslint.configs.recommended.map((cfg) => ({
    ...cfg,
    files: ['**/*.{ts,tsx}'],
  })),
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    plugins: { turbo: turboPlugin },
    rules: {
      'turbo/no-undeclared-env-vars': 'error',
    },
  },
  eslintConfigPrettier,
];
