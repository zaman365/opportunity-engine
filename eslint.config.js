import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '**/dist/**',
      'coverage/**',
      'opportunity-engine-build-kit/**',
      'playwright-report/**',
      'test-results/**',
      '.local-evidence/**',
    ],
  },
  {
    // Node scripts and configs run outside the browser.
    files: ['scripts/**/*.{js,mjs,ts}', '*.config.{js,ts}', 'eslint.config.js'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "BinaryExpression[operator='+'][left.property.name=/micro$/], BinaryExpression[operator='-'][left.property.name=/micro$/]",
          message: 'Money is integer micro-units; use the BigInt money helpers in @oe/domain.',
        },
      ],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['apps/operator/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'tests/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
