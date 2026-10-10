// eslint.config.base.mjs
// Shared flat-config array. Every package's own eslint.config.mjs imports
// this and spreads it as the base of its own array — see Task 6/7. Do not
// add per-package "ignores" for .venv/.pytest_cache/node_modules/etc.;
// that belongs here, once, so every package inherits it automatically.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import turboPlugin from "eslint-plugin-turbo";
import eslintConfigPrettier from "eslint-config-prettier";

export default [
  {
    ignores: [
      "**/.venv/**",
      "**/.pytest_cache/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/.turbo/**",
      "**/.worktrees/**",
      "**/.state/**",
    ],
  },
  { files: ["**/*.{js,mjs,cjs}"], ...js.configs.recommended },
  ...tseslint.configs.recommended.map((cfg) => ({
    ...cfg,
    files: ["**/*.{ts,tsx}"],
  })),
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    plugins: { turbo: turboPlugin },
    rules: {
      "turbo/no-undeclared-env-vars": "error",
    },
  },
  eslintConfigPrettier,
];
