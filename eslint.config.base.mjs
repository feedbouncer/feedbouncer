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

// Keeps process.env behind a single typed config layer. `exempt` lists the exact
// files (or test-only directories) that may read it; keep it as narrow as possible.
export function restrictProcessEnv({ exempt, message }) {
  return {
    files: ['src/**/*.ts'],
    ignores: exempt,
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'env', message },
        { object: 'globalThis', property: 'process', message },
        { object: 'global', property: 'process', message },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: ['node:process', 'process'].map((name) => ({
            name,
            importNames: ['env'],
            message,
          })),
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "VariableDeclarator[init.type='Identifier'][init.name='process']",
          message: `${message} Do not alias or destructure process.`,
        },
        {
          selector: "AssignmentExpression[right.type='Identifier'][right.name='process']",
          message: `${message} Do not alias or destructure process.`,
        },
      ],
    },
  };
}
