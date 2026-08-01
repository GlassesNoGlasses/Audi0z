import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

/**
 * Deliberately small: typescript-eslint's recommended rules everywhere, the react-hooks rules in
 * the renderer, and nothing that overlaps with prettier (formatting is prettier's job).
 */
export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'dist/**',
      'coverage/**',
      'resources/bin/**',
      'playwright-report/**',
      'test-results/**'
    ]
  },
  tseslint.configs.recommended,
  {
    // Only the two classic hook rules. The rest of the plugin's "recommended" set is aimed at the
    // React Compiler, which this app does not use.
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  }
)
