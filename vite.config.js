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
  server: {
    // Honor the PORT env var. The Claude preview tool (and many PaaS hosts)
    // assign a port by setting PORT and then point the browser at it — but
    // Vite does NOT read PORT on its own. Without this it ignores the
    // assignment, falls back to 5173, and silently drifts to 5174+ when that's
    // taken (e.g. a stale dev server), leaving the preview browser pointed at a
    // port nothing is listening on → a chrome-error blank page. When PORT is
    // set we also use strictPort so Vite binds EXACTLY that port (failing
    // loudly if it's busy) instead of drifting off it. Plain `npm run dev`
    // (no PORT) keeps the usual 5173-with-auto-increment behavior.
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    strictPort: !!process.env.PORT,
  },
})
