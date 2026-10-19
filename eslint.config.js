// A deliberately small rule set (#118): mistakes a reviewer would flag, not style.
// Run with `npm run lint`; `npm run check` runs it after the syntax and unused-export checks.
// no-shadow is not enabled: it reports 123 existing shadows, almost all local names that
// intentionally reuse a module-level schema constant's name (for example `workspaceId`).
// The harmful case it would catch, an unused shadowing declaration, no-unused-vars reports.
export default [
  { ignores: ['node_modules/**', 'dist/**', 'artifacts/**', 'test/visual/_failures/**', '.claude/**'] },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_' }],
      // A block that holds only a comment documents an intentional no-op and is allowed.
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-unreachable': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': ['error', { destructuring: 'all', ignoreReadBeforeAssign: true }],
    },
  },
  { files: ['**/*.cjs'], languageOptions: { sourceType: 'commonjs' } },
];
