// Miscellaneous small UI preferences (param-name column width, panel widths,
// collapsed panels, …) — layout state that is neither a design property nor an
// app setting worth a SettingsPanel row.
//
// Persistence is LAYERED exactly like src/ui/twoLineSettings.js / settings.js
// (this user's browser silently drops localStorage writes — do NOT revert to
// bare localStorage):
//   1. in-memory module cache — authoritative for the session;
//   2. window.storage (IndexedDB) — durable, written fire-and-forget;
//   3. localStorage — best-effort synchronous fast path on a fresh reload.
//
// The key is outside every workspace prefix so these never ride along in
// design/workspace exports.

const KEY = 'photonic_layout_ui_prefs';

let cache = null;          // non-null once a set/hydrate landed this session
let hydratePromise = null;

// TEST HOOK: reset the module-level layers between unit tests.
export function _resetUiPrefsForTests() {
  cache = null;
  hydratePromise = null;
}

function safeParse(raw) {
  try {
    const p = JSON.parse(raw);
    return p && typeof p === 'object' && !Array.isArray(p) ? p : null;
  } catch { return null; }
}

function safeLocalStorage() {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch { /* access denied */ }
  return null;
}

// SYNCHRONOUS read of the whole pref object (session cache first, then the
// localStorage fast path). Returns {} when nothing is stored.
export function loadUiPrefs() {
  if (cache) return { ...cache };
  const ls = safeLocalStorage();
  if (ls) {
    try {
      const parsed = safeParse(ls.getItem(KEY));
      if (parsed) return { ...parsed };
    } catch { /* ignore */ }
  }
  return {};
}

// Convenience: one pref with a fallback.
export function getUiPref(key, fallback) {
  const p = loadUiPrefs();
  return Object.prototype.hasOwnProperty.call(p, key) ? p[key] : fallback;
}

// ASYNC hydrate from IndexedDB. Memoized so main.jsx (pre-mount warm) and the
// app (merge into React state) share one consistent result. A set() that
// landed first wins — the session cache is authoritative.
export function hydrateUiPrefs() {
  if (!hydratePromise) {
    hydratePromise = (async () => {
      try {
        if (typeof window !== 'undefined' && window.storage && typeof window.storage.get === 'function') {
          const r = await window.storage.get(KEY);
          const raw = r == null ? null : (typeof r === 'string' ? r : r.value);
          const parsed = raw ? safeParse(raw) : null;
          if (parsed && cache == null) cache = { ...parsed };
        }
      } catch { /* durable store unavailable */ }
      return cache ? { ...cache } : null;
    })();
  }
  return hydratePromise;
}

// Merge-set one (or more) prefs and write through every layer.
export function setUiPrefs(patch) {
  if (!patch || typeof patch !== 'object') return;
  cache = { ...(cache || loadUiPrefs()), ...patch };
  const json = JSON.stringify(cache);
  try {
    if (typeof window !== 'undefined' && window.storage && typeof window.storage.set === 'function') {
      Promise.resolve(window.storage.set(KEY, json)).catch(() => {});
    }
  } catch { /* ignore */ }
  const ls = safeLocalStorage();
  if (ls) {
    try { ls.setItem(KEY, json); } catch { /* blocked — cache+IDB hold it */ }
  }
}
