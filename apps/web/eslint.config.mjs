import baseConfig from '../../eslint.config.base.mjs';

export default [
  ...baseConfig,
  { ignores: ['.next/**', 'next-env.d.ts'] },
  {
    files: ['**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'API text must render as escaped text, never as HTML.',
        },
      ],
    },
  },
];
