// SETUP-panel defaults — the user's last-used simSetup config (HFSS/Q2D
// export target, adaptive-solve knobs, frequency sweep, chip pads, air
// box), remembered app-wide so every NEW design starts from it.
//
// Scope contract: `scene.simSetup` stays the per-design source of truth
// (it saves/loads with the design as before). This store only supplies
// the SEED for scenes that are freshly created (new design / new blank /
// first boot with no saved design). It is written on every deliberate
// SETUP-panel edit (updateSim) — merely LOADING an old design never
// overwrites the remembered values.
//
// Persistence is layered (same rationale as twoLineSettings.js — this
// user's browser silently drops localStorage writes):
//   1. In-memory session cache — authoritative for the running session.
//   2. IndexedDB via `window.storage` — durable; written fire-and-forget,
//      hydrated once at boot (`hydrateSetupDefaults` in main.jsx).
//   3. localStorage — best-effort synchronous restore on fresh reload.
//
// The key is outside every workspace prefix, so remembered values never
// ride along in design/workspace exports.

const KEY = 'photonic_layout_setup_defaults';

let cache = null;
let hydrated = false;

// Keep only plain scalar entries (simSetup is strings + booleans; a
// number is tolerated and kept as-is). Anything structured is dropped —
// a corrupted blob can only lose remembered values, never poison a
// scene. Generic (no field whitelist) so future simSetup knobs persist
// without touching this file.
export function sanitizeSetup(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (typeof v === 'string' || typeof v === 'boolean'
      || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function unwrap(r) {
  if (r == null) return null;
  if (typeof r === 'string') return r;
  if (typeof r === 'object' && 'value' in r) return r.value;
  return null;
}

const durableStore = (storage) => {
  if (storage) return storage; // explicit injection (tests)
  try { return (typeof window !== 'undefined' && window.storage) || null; } catch { return null; }
};

// SYNCHRONOUS read for scene-creation seeding. In-memory cache first,
// then best-effort localStorage (covers a reload that beat the async
// IndexedDB hydrate). Returns the remembered simSetup or null.
export function loadSetupDefaults() {
  if (cache) return cache;
  try {
    const raw = typeof window !== 'undefined' && window.localStorage
      ? window.localStorage.getItem(KEY) : null;
    if (raw) {
      cache = sanitizeSetup(JSON.parse(raw));
      return cache;
    }
  } catch {
    /* localStorage blocked — rely on hydrate / in-memory cache */
  }
  return null;
}

// ASYNC hydrate from the durable store. Call once at app boot (after
// installStorageShim). Idempotent; never clobbers a value already set
// this session.
export async function hydrateSetupDefaults(storage) {
  if (hydrated) return cache;
  hydrated = true;
  try {
    const ds = durableStore(storage);
    if (cache == null && ds && typeof ds.get === 'function') {
      const raw = unwrap(await ds.get(KEY));
      // Re-check after the await: a save that landed while the read was
      // in flight is newer than the durable blob — never clobber it.
      if (cache == null && raw) cache = sanitizeSetup(JSON.parse(raw));
    }
  } catch {
    /* durable store unavailable — fall back to localStorage / schema defaults */
  }
  return cache;
}

// Persist on every SETUP-panel change: in-memory cache synchronously
// (cannot fail), then write-through to IndexedDB (durable) and
// localStorage (best-effort) — both swallow errors.
export function saveSetupDefaults(simSetup, storage) {
  const norm = sanitizeSetup(simSetup);
  if (!norm) return false;
  cache = norm;
  hydrated = true; // a real value exists in memory; a late hydrate must not overwrite it
  const json = JSON.stringify(norm);
  try {
    const ds = durableStore(storage);
    if (ds && typeof ds.set === 'function') {
      Promise.resolve(ds.set(KEY, json)).catch(() => {});
    }
  } catch {
    /* ignore */
  }
  try {
    if (typeof window !== 'undefined' && window.localStorage) window.localStorage.setItem(KEY, json);
  } catch {
    /* localStorage blocked — IndexedDB + in-memory cache still hold the value */
  }
  return true;
}

// Test hook: reset module state so each test starts cold.
export function _resetSetupDefaultsForTests() {
  cache = null;
  hydrated = false;
}
