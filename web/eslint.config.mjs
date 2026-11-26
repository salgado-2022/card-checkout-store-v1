// ESLint flat config for the web SPA (ESLint v10). Legacy .eslintrc* files are not used.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettierRecommended from 'eslint-plugin-prettier/recommended';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mjs}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.flat['recommended-latest'].rules,
  },
  // Runs Prettier as an ESLint rule (prettier/prettier) and disables conflicting style rules.
  prettierRecommended,
);
