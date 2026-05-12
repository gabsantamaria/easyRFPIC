// Install a localStorage-backed implementation of `window.storage` when
// the host doesn't provide one of its own.
//
// The storage modules under src/storage/{workspace,library-items}.js call
// `window.storage.{get,set,delete,list}` — an interface the app
// originally inherited from the Claude artifacts viewer, which injects
// it as a host capability. When running under `vite dev` / `vite build`
// in a regular browser there's no host injection, so every call would
// throw and the storage layer's try/catch would silently swallow it.
// The visible effect: saves succeed in-memory but nothing persists
// across a reload.
//
// This shim wires the same interface to `localStorage`, so designs,
// libraries, archives, the active workspace, and the active design
// name all survive a refresh. Browsers cap localStorage at ~5–10 MB
// per origin; for unlimited capacity, link the workspace to a JSON
// file on disk (handled by src/storage/file-handle.js — independent
// of this shim).
//
// We install only if `window.storage` isn't already present, so a host
// that DOES provide its own implementation (artifacts viewer, an
// Electron shell, etc.) wins.
export function installLocalStorageShim() {
  if (typeof window === 'undefined') return; // SSR / Node
  if (window.storage) return;                 // host-provided wins

  let backend;
  try {
    // Round-trip a sentinel to confirm localStorage is actually writable
    // (Safari Private Browsing, very-locked-down policies, etc. expose
    // the API but throw on set). If it fails we fall through to an
    // in-memory Map — the session won't persist but the app still runs.
    const sentinel = '__photonic_layout_storage_probe__';
    window.localStorage.setItem(sentinel, '1');
    window.localStorage.removeItem(sentinel);
    backend = {
      keys: () => {
        const out = [];
        for (let i = 0; i < window.localStorage.length; i++) {
          const k = window.localStorage.key(i);
          if (k != null) out.push(k);
        }
        return out;
      },
      get: (key) => window.localStorage.getItem(key),
      set: (key, value) => window.localStorage.setItem(key, value),
      delete: (key) => window.localStorage.removeItem(key),
    };
  } catch {
    const mem = new Map();
    backend = {
      keys: () => Array.from(mem.keys()),
      get: (key) => (mem.has(key) ? mem.get(key) : null),
      set: (key, value) => { mem.set(key, value); },
      delete: (key) => { mem.delete(key); },
    };
    console.warn('photonic-layout: localStorage unavailable; persistence disabled for this session.');
  }

  window.storage = {
    async list(prefix) {
      const keys = backend.keys().filter((k) => k.startsWith(prefix));
      return { keys };
    },
    async get(key) {
      const v = backend.get(key);
      return v == null ? null : { value: v };
    },
    async set(key, value) {
      backend.set(key, value);
    },
    async delete(key) {
      backend.delete(key);
    },
  };
}
