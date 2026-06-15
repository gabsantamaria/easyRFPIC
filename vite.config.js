import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// App version shown in the header. Releases are git tags (see
// scripts/release.mjs + .github/workflows/deploy.yml), so the version is
// resolved at build time, in order:
//   1. VITE_APP_VERSION env  — set by the deploy workflow to the release
//      tag (github.ref_name), the authoritative source for published builds.
//   2. the latest `git describe` tag — for local builds / dev servers.
//   3. '0.0.0-dev'           — when neither is available (e.g. a tarball
//      checkout with no git / no tags).
// The leading 'v' is stripped so the UI shows "0.1.19", not "v0.1.19".
function resolveAppVersion() {
  // Only accept a version-LIKE env value (e.g. "v0.1.19" / "0.1.19"). On a
  // workflow_dispatch run github.ref_name is a branch name ("main"), which
  // should fall through to git describe rather than be shown as the version.
  const env = (process.env.VITE_APP_VERSION || '').trim()
  if (/^v?\d+\.\d+\.\d+/.test(env)) return env.replace(/^v/, '')
  try {
    const tag = execSync('git describe --tags --abbrev=0', {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim()
    if (tag) return tag.replace(/^v/, '')
  } catch {
    // not a git checkout, or no tags yet — fall through
  }
  return '0.0.0-dev'
}

export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  define: {
    __APP_VERSION__: JSON.stringify(resolveAppVersion()),
  },
  plugins: [react(), tailwindcss()],
})
