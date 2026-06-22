// 2-line method wizard — last-used field values.
//
// Persistence is layered so the wizard's "remember my last entries" survives
// every storage policy, not just the friendly case:
//
//   1. In-memory session cache (`cache`) — AUTHORITATIVE for the running
//      session. This is what makes "open wizard → change values → close →
//      reopen" always restore, EVEN IF the browser is silently dropping
//      localStorage writes (Safari private mode, blocked-storage policies,
//      quota exhaustion, storage partitioning). It's plain JS state, so it
//      cannot fail. It does NOT survive a page reload — that's what layers
//      2/3 are for.
//   2. IndexedDB via `window.storage` — the DURABLE store, the same backend
//      saved designs persist in (so if designs survive a reload/rebuild for
//      this user, these prefs now will too). Async; written fire-and-forget
//      and hydrated once at app boot (`hydrateTwoLinePrefs`).
//   3. localStorage — best-effort only: a fast SYNCHRONOUS restore on a fresh
//      reload that races ahead of the async IndexedDB hydrate. Skipped
//      silently when the browser blocks it.
//
// The key is NOT one of the workspace storage prefixes, so these values can
// never ride along in a design export, a workspace export/import bundle, or a
// generated script (same isolation rationale as the AI key + app settings).
// Global (not per-workspace) — a restored lengthParam that doesn't exist in
// the current design falls back to the first parameter, and L1/L2 are freely
// editable, so a stale value is harmless.

const KEY = 'photonic_layout_two_line';

// In-memory cache — survives same-session close→reopen regardless of browser
// storage policy. Populated by saveTwoLinePrefs (on every change) and by
// hydrateTwoLinePrefs (once, at boot, from IndexedDB).
let cache = null;
let hydrated = false;

// Coerce a raw object into the canonical (all-string + typed flags) shape.
function normalize(p) {
  if (!p || typeof p !== 'object') return null;
  const str = (v) => (typeof v === 'string' ? v : (v == null ? '' : String(v)));
  return {
    lengthParam: str(p.lengthParam),
    l1: str(p.l1),
    l2: str(p.l2),
    separation: str(p.separation),
    freqStart: str(p.freqStart),
    freqStop: str(p.freqStop),
    freqPoints: str(p.freqPoints),
    cFperM: str(p.cFperM),
    q3dThk: str(p.q3dThk),
    q3dLen: str(p.q3dLen),
    bundleQ3D: !!p.bundleQ3D,
    q3dIds: Array.isArray(p.q3dIds) ? p.q3dIds.filter((x) => typeof x === 'string') : [],
    q3dCg: str(p.q3dCg),
    q3dMinP: str(p.q3dMinP),
    q3dMaxP: str(p.q3dMaxP),
  };
}

// Unwrap whatever window.storage.get returns ({value} wrapper, or a bare
// string from a host-provided implementation) into the raw JSON string.
function unwrap(r) {
  if (r == null) return null;
  if (typeof r === 'string') return r;
  if (typeof r === 'object' && 'value' in r) return r.value;
  return null;
}

// SYNCHRONOUS read for the wizard's mount initializer. In-memory cache first
// (covers same-session reopen + any post-hydrate reload); then a best-effort
// synchronous localStorage read (covers a reload that beat the async IndexedDB
// hydrate, when localStorage happens to work). Returns prefs or null.
export function loadTwoLinePrefs() {
  if (cache) return cache;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      cache = normalize(JSON.parse(raw));
      return cache;
    }
  } catch {
    /* localStorage blocked — rely on hydrateTwoLinePrefs / in-memory cache */
  }
  return null;
}

// ASYNC hydrate from the durable IndexedDB store. Call once at app boot (after
// installStorageShim) so a fresh reload restores the last-used values even
// when localStorage is unavailable. Idempotent; populates the in-memory cache
// (without clobbering a value already set this session).
export async function hydrateTwoLinePrefs() {
  if (hydrated) return cache;
  hydrated = true;
  try {
    if (cache == null && window.storage && typeof window.storage.get === 'function') {
      const raw = unwrap(await window.storage.get(KEY));
      if (raw) cache = normalize(JSON.parse(raw));
    }
  } catch {
    /* durable store unavailable — fall back to localStorage / defaults */
  }
  return cache;
}

// Persist on every change. Always updates the in-memory cache synchronously
// (the part that cannot fail), then writes through to IndexedDB (durable) and
// localStorage (best-effort) — both swallow errors so a blocked backend never
// breaks the wizard.
export function saveTwoLinePrefs(prefs) {
  const norm = normalize(prefs) || normalize({});
  cache = norm;
  hydrated = true; // a real value now exists in memory; don't let a late hydrate overwrite it
  const json = JSON.stringify(norm);
  try {
    if (window.storage && typeof window.storage.set === 'function') {
      Promise.resolve(window.storage.set(KEY, json)).catch(() => {});
    }
  } catch {
    /* ignore */
  }
  try {
    window.localStorage.setItem(KEY, json);
  } catch {
    /* localStorage blocked — IndexedDB + in-memory cache still hold the value */
  }
  return true;
}
