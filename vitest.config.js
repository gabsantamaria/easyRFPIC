// Vitest config — picks up only the *.test.{js,mjs,jsx} files under
// tests/, leaving the older node-script tests (test_*.mjs / regen.mjs /
// _harness.mjs) alone so they can keep running directly via `node`.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{js,mjs,jsx}'],
    exclude: ['node_modules/**', 'dist/**', 'tests/out/**'],
  },
});
