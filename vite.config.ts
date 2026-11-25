import { defineConfig } from 'vite-plus'

const ignorePatterns = [
  '.agents/**',
  'AGENTS.md',
  'out/**',
  'dist/**',
  'debug/**',
  'native/**',
  'auto-imports.d.ts',
  'components.d.ts'
]

export default defineConfig({
  staged: {
    '*': 'vp check --fix'
  },
  test: {
    include: ['tests/**/*.test.ts']
  },
  fmt: {
    singleQuote: true,
    semi: false,
    trailingComma: 'none',
    printWidth: 120,
    ignorePatterns
  },
  lint: {
    ignorePatterns,
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: {
      'vite-plus/prefer-vite-plus-imports': 'error'
    },
    options: {
      typeAware: true,
      typeCheck: true
    }
  }
})
