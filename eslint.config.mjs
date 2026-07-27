import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

// Flat config for ESLint 10. The project is split across four TS sub-projects:
// shared/main/preload run in Node, renderer runs in the browser with React.
export default tseslint.config(
  {
    ignores: ['out/**', 'release/**', 'node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // `_`-prefixed names are intentional "ignore this binding" markers
  // (unused callback args, dropped destructured values).
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },
  // Node-side code: main process, preload bridge, shared contracts, and the
  // bundled Pi extension / shared permission engine under resources/ (loaded by
  // Pi via jiti; imports only from node:*).
  {
    files: ['src/{main,preload,shared}/**/*.ts', 'resources/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  // Renderer: React with browser globals + Rules of Hooks enforcement.
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
    },
    // Keep the classic Rules of Hooks + exhaustive-deps policy. react-hooks 7's
    // `recommended-latest` adds new opinionated rules (set-state-in-effect,
    // static-components); adopting those is a separate, deliberate code-quality
    // pass, not something to inherit implicitly from a version bump.
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  // CommonJS Node scripts: CLI launcher and install hooks. `require()` is the
  // correct module syntax here, so the TS-oriented rule is disabled.
  {
    files: ['bin/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
)
