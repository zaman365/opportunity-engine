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
    // Node scripts, fixture servers and configs run outside the browser.
    files: [
      'scripts/**/*.{js,mjs,ts}',
      'fixtures/**/*.mjs',
      '*.config.{js,ts}',
      'eslint.config.js',
    ],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        crypto: 'readonly',
        AbortSignal: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
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
    // The operator's own build config runs in Node, so it is exempt from the browser rules
    // that apply to everything the bundle ships.
    files: ['apps/operator/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The operator is a browser bundle. @oe/domain, @oe/db and @oe/capture reach for
      // node:net, node:crypto and pg; importing one pulls a Node builtin into the client and
      // breaks at runtime, not at build time. Anything the UI needs from the server comes
      // over the wire through @oe/contracts.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@oe/domain',
              message: 'Server-only. Take the value from the API response instead.',
            },
            { name: '@oe/db', message: 'Server-only.' },
            { name: '@oe/capture', message: 'Server-only.' },
            { name: '@oe/evidence', message: 'Server-only.' },
          ],
          patterns: ['node:*'],
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'tests/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
