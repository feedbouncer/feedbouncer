import js from '@eslint/js';
import { n8nCommunityNodesPlugin } from '@n8n/eslint-plugin-community-nodes';
import { defineConfig, globalIgnores } from 'eslint/config';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import importX from 'eslint-plugin-import-x';
import tseslint from 'typescript-eslint';

const communityNodes = n8nCommunityNodesPlugin.configs.recommended;

export default defineConfig(
  globalIgnores(['dist']),
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended, communityNodes, importX.configs['flat/recommended']],
    rules: { 'prefer-spread': 'off', 'no-console': 'error' },
  },
  { settings: { 'import-x/resolver-next': [createTypeScriptImportResolver()] } },
  {
    files: ['package.json', '**/*.node.json'],
    extends: [communityNodes],
    languageOptions: { parser: tseslint.parser, parserOptions: { extraFileExtensions: ['.json'] } },
  },
);
