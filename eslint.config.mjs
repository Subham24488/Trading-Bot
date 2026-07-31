import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'coverage/', 'prisma/generated/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
