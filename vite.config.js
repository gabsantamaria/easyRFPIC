import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// `base` is the URL prefix the built site lives at. The default '/' is
// correct for Vercel / Netlify / Cloudflare Pages / a custom domain.
// GitHub Pages hosts user repos under `https://<user>.github.io/<repo>/`,
// which needs base = `/<repo>/`. The GitHub Actions workflow sets
// VITE_BASE_PATH at build time so both targets work from the same config.
export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react(), tailwindcss()],
})
