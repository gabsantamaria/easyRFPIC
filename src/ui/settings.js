// User settings model: a small, fully-serializable preference object persisted
// to localStorage and exportable/importable as JSON.
//
// Lives under its OWN localStorage key (`photonic_layout_settings`), outside
// any workspace prefix, so settings never ride along in design/workspace
// exports. The AI API key is deliberately NOT here — it stays in
// src/ai/settings.js and must never be exported with settings.
//
// Pure except for the localStorage I/O in loadSettings/saveSettings, so the
// load/merge/validate/export/import logic unit-tests directly.

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

// Read persisted settings, merged over defaults. On the first run of the new
// model (no SETTINGS_KEY yet) migrate the legacy edit-dims toggle. Read-only —
// the caller persists once on mount so the migration sticks.
export function loadSettings(storage) {
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

// Persist settings (whitelisted keys only). Returns true on success.
export function saveSettings(settings, storage) {
  const ls = storage || safeLocalStorage();
  if (!ls) return false;
  try {
    ls.setItem(SETTINGS_KEY, JSON.stringify(whitelist(settings)));
    return true;
  } catch {
    return false;
  }
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
