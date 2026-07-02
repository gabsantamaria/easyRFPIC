// User settings model: a small, fully-serializable preference object persisted
// with LAYERED durability and exportable/importable as JSON.
//
// Lives under its OWN key (`photonic_layout_settings`), outside any workspace
// prefix, so settings never ride along in design/workspace exports. The AI API
// key is deliberately NOT here — it stays in src/ai/settings.js and must never
// be exported with settings.
//
// PERSISTENCE is layered exactly like src/ui/twoLineSettings.js (see the
// rationale there — this user's browser silently drops localStorage writes):
//   1. in-memory module cache — authoritative for the session, cannot fail;
//   2. window.storage (IndexedDB) — durable, written fire-and-forget on every
//      save and hydrated once at boot via hydrateSettings();
//   3. localStorage — best-effort synchronous fast path for a fresh reload.
// Do NOT revert to bare localStorage — that reintroduces the silent-reset bug.
//
// The pure load/merge/validate/export/import logic still unit-tests directly:
// loadSettings/saveSettings keep an explicit `storage` parameter that, when
// provided (tests), bypasses the layering entirely.

import { isThemeId, DEFAULT_THEME_ID } from './theme.js';

export const SETTINGS_KEY = 'photonic_layout_settings';
// Legacy standalone key for the edit-dims toggle, migrated into
// `showDimensionsOnSelect` on first load of the new model.
const LEGACY_EDITDIMS_KEY = 'photonic_layout_edit_dims';

export const DEFAULT_SETTINGS = Object.freeze({
  theme: DEFAULT_THEME_ID,        // appearance theme id
  showDimensionsOnSelect: true,   // editable dimension arrows on the selected shape (default ON)
  showDimensionsOverlay: false,   // read-only dimension-arrow overlay for every part
  gridVisible: true,              // draw the background grid
  gridSnap: true,                 // snap drags to the grid
  gridSize: 2,                    // grid pitch (µm)
  autosaveSeconds: 2,             // debounce before autosaving after the last edit
});

// Per-key validators. Each returns the coerced value, or undefined to reject
// (the key is then omitted — never silently reset to default on import).
const VALIDATORS = {
  theme: (v) => (isThemeId(v) ? v : undefined),
  showDimensionsOnSelect: coerceBool,
  showDimensionsOverlay: coerceBool,
  gridVisible: coerceBool,
  gridSnap: coerceBool,
  gridSize: (v) => {
    const n = typeof v === 'number' ? v : parseFloat(v);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return Math.min(1e6, Math.max(0.1, n));
  },
  autosaveSeconds: (v) => {
    const n = typeof v === 'number' ? v : parseFloat(v);
    if (!Number.isFinite(n)) return undefined;
    return Math.min(60, Math.max(1, Math.round(n)));
  },
};

function coerceBool(v) {
  if (typeof v === 'boolean') return v;
  return undefined;
}

// Sanitize an arbitrary object into a partial settings object: only keys that
// exist in DEFAULT_SETTINGS AND pass validation are kept. Returns
// { values, applied, skipped } where `skipped` lists present-but-rejected keys.
export function coerceSettings(obj) {
  const values = {};
  const applied = [];
  const skipped = [];
  if (!obj || typeof obj !== 'object') return { values, applied, skipped };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    const coerced = VALIDATORS[key](obj[key]);
    if (coerced === undefined) { skipped.push(key); continue; }
    values[key] = coerced;
    applied.push(key);
  }
  return { values, applied, skipped };
}

// In-memory session cache (layer 1) + one-shot hydrate promise. `cache`
// non-null means a saveSettings ran this session (or hydrate landed) — the
// session value always wins over a late IDB read.
let cache = null;
let hydratePromise = null;

// TEST HOOK: reset the module-level layers between unit tests.
export function _resetSettingsLayersForTests() {
  cache = null;
  hydratePromise = null;
}

// Read persisted settings, merged over defaults. On the first run of the new
// model (no SETTINGS_KEY yet) migrate the legacy edit-dims toggle. Read-only —
// the caller persists once (after hydration) so the migration sticks.
// With an explicit `storage` (tests) the layered cache is bypassed.
export function loadSettings(storage) {
  if (!storage && cache) return { ...cache };
  const ls = storage || safeLocalStorage();
  let parsed = null;
  if (ls) {
    try {
      const raw = ls.getItem(SETTINGS_KEY);
      if (raw != null) parsed = JSON.parse(raw);
    } catch { /* corrupt — fall through to defaults */ }
  }
  if (parsed && typeof parsed === 'object') {
    const { values } = coerceSettings(parsed);
    return { ...DEFAULT_SETTINGS, ...values };
  }
  // No stored settings → migrate legacy edit-dims ('0' meant OFF; ON otherwise).
  const out = { ...DEFAULT_SETTINGS };
  if (ls) {
    try {
      const legacy = ls.getItem(LEGACY_EDITDIMS_KEY);
      if (legacy != null) out.showDimensionsOnSelect = legacy !== '0';
    } catch { /* ignore */ }
  }
  return out;
}

// ASYNC hydrate from the durable IndexedDB store (window.storage). Memoized:
// main.jsx warms it pre-mount and PhotonicLayout awaits the SAME promise to
// merge the durable values into React state — both get one consistent result.
// A saveSettings that lands first wins (cache is authoritative for the session).
export function hydrateSettings() {
  if (!hydratePromise) {
    hydratePromise = (async () => {
      try {
        if (typeof window !== 'undefined' && window.storage && typeof window.storage.get === 'function') {
          const r = await window.storage.get(SETTINGS_KEY);
          const raw = r == null ? null : (typeof r === 'string' ? r : r.value);
          if (raw && cache == null) {
            const { values } = coerceSettings(JSON.parse(raw));
            cache = { ...DEFAULT_SETTINGS, ...values };
          }
        }
      } catch { /* durable store unavailable — localStorage/defaults stand */ }
      return cache ? { ...cache } : null;
    })();
  }
  return hydratePromise;
}

// Persist settings (whitelisted keys only). Returns true on success.
// Layered: session cache (cannot fail) → IndexedDB write-through
// (fire-and-forget) → localStorage best-effort. An explicit `storage`
// (tests) bypasses the layering and writes only there.
export function saveSettings(settings, storage) {
  if (storage) {
    try {
      storage.setItem(SETTINGS_KEY, JSON.stringify(whitelist(settings)));
      return true;
    } catch { return false; }
  }
  const clean = whitelist(settings);
  cache = clean;
  const json = JSON.stringify(clean);
  try {
    if (typeof window !== 'undefined' && window.storage && typeof window.storage.set === 'function') {
      Promise.resolve(window.storage.set(SETTINGS_KEY, json)).catch(() => {});
    }
  } catch { /* ignore */ }
  const ls = safeLocalStorage();
  if (ls) {
    try { ls.setItem(SETTINGS_KEY, json); } catch { /* blocked — cache+IDB hold it */ }
  }
  return true;
}

// JSON payload for "Export settings".
export function buildSettingsExport(settings, exportedAt) {
  let when = exportedAt;
  if (when === undefined) {
    try { when = new Date().toISOString(); } catch { when = null; }
  }
  return {
    format: 'photonic-layout-settings',
    version: 1,
    exportedAt: when || null,
    settings: whitelist(settings),
  };
}

// Apply an imported JSON object as a PARTIAL update over the CURRENT settings:
// only keys that are present AND valid are taken; everything else keeps its
// current value (so a JSON missing a setting leaves that setting untouched).
// Accepts either the `{ format, settings }` wrapper or a bare settings object.
export function parseSettingsImport(parsed, current) {
  const base = { ...DEFAULT_SETTINGS, ...whitelist(current) };
  const incoming = parsed && typeof parsed === 'object' && parsed.settings && typeof parsed.settings === 'object'
    ? parsed.settings
    : parsed;
  const { values, applied, skipped } = coerceSettings(incoming);
  return { settings: { ...base, ...values }, applied, skipped };
}

// Pick only the known settings keys (drops anything extraneous / sensitive).
function whitelist(settings) {
  const out = {};
  if (!settings || typeof settings !== 'object') return { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    out[key] = Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : DEFAULT_SETTINGS[key];
  }
  return out;
}

function safeLocalStorage() {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch { /* access denied */ }
  return null;
}
