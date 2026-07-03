// Section-wizard prefs (Q2D cross-section + Tidy3D EO wizards) — last-used
// field values, PLUS the pure conductor-role heuristic both wizards share.
//
// Persistence is LAYERED exactly like twoLineSettings.js (see the rationale
// there — this user's browser silently drops localStorage writes):
//   1. In-memory session cache — AUTHORITATIVE for the running session; makes
//      close→reopen restore even when browser storage is blocked entirely.
//   2. IndexedDB via `window.storage` — the durable store; written
//      fire-and-forget on every save, hydrated once at app boot
//      (`hydrateSectionWizardPrefs`, wired in main.jsx).
//   3. localStorage — best-effort synchronous fast path for a fresh reload.
// Do NOT collapse this to bare localStorage — that reintroduces the
// silent-forget bug for this user.
//
// ONE key holds BOTH wizards' prefs ({ q2d, tidy3d }); saveSectionWizardPrefs
// takes a PARTIAL ({ q2d: {...} } or { tidy3d: {...} }) and merges per-field
// over the current values, so saving one wizard can never clobber the other.
// The key is OUTSIDE every workspace storage prefix, so these values never
// ride along in a design/workspace export or a generated script.

export const SECTION_WIZARD_KEY = 'photonic_layout_section_wizards';

// In-memory cache — survives same-session close→reopen regardless of browser
// storage policy. Populated by saveSectionWizardPrefs (on every change) and by
// hydrateSectionWizardPrefs (once, at boot, from IndexedDB).
let cache = null;
let hydrated = false;

// TEST HOOK: reset the module-level layers between unit tests.
export function _resetSectionWizardPrefsForTests() {
  cache = null;
  hydrated = false;
}

const str = (v) => (typeof v === 'string' ? v : (v == null ? '' : String(v)));

// Role maps persist only the user's EXPLICIT overrides ({ conductorId:
// 'signal'|'ground' }); anything else is dropped so a corrupt store can't
// feed garbage into the role table.
function normRoles(r) {
  const out = {};
  if (r && typeof r === 'object') {
    for (const k of Object.keys(r)) {
      if (r[k] === 'signal' || r[k] === 'ground') out[k] = r[k];
    }
  }
  return out;
}

// Canonical (all-string + typed) shapes. Blank string = "never set" — the
// wizards fall back to their seeded defaults on a falsy field, so an empty
// normalized record behaves exactly like no record at all.
function normQ2d(p) {
  const q = p && typeof p === 'object' ? p : {};
  return {
    freqStart: str(q.freqStart),
    freqStop: str(q.freqStop),
    freqPoints: str(q.freqPoints),
    adaptiveFreq: str(q.adaptiveFreq),
    cgErr: str(q.cgErr),
    rlErr: str(q.rlErr),
    minPass: str(q.minPass),
    maxPass: str(q.maxPass),
    zeroThk: str(q.zeroThk),
    roles: normRoles(q.roles),
  };
}

function normTidy3d(p) {
  const t = p && typeof p === 'object' ? p : {};
  return {
    lambdaUm: str(t.lambdaUm),
    ne: str(t.ne),
    no: str(t.no),
    // 'vertical' = extraordinary axis along the stack normal (z-cut LN);
    // 'horizontal' = along the section line (x-cut LN). Anything else → the
    // z-cut default.
    eoAxis: t.eoAxis === 'horizontal' ? 'horizontal' : 'vertical',
    r33: str(t.r33),
    r13: str(t.r13),
    eoLayerId: str(t.eoLayerId),
    numModes: str(t.numModes),
    freqStart: str(t.freqStart),
    freqStop: str(t.freqStop),
    freqPoints: str(t.freqPoints),
    roles: normRoles(t.roles),
  };
}

function normalize(p) {
  if (!p || typeof p !== 'object') return null;
  return { q2d: normQ2d(p.q2d), tidy3d: normTidy3d(p.tidy3d) };
}

const emptyPrefs = () => ({ q2d: normQ2d(null), tidy3d: normTidy3d(null) });

// Unwrap whatever window.storage.get returns ({value} wrapper, or a bare
// string from a host-provided implementation) into the raw JSON string.
function unwrap(r) {
  if (r == null) return null;
  if (typeof r === 'string') return r;
  if (typeof r === 'object' && 'value' in r) return r.value;
  return null;
}

function safeLocalStorage() {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch { /* access denied */ }
  return null;
}

// SYNCHRONOUS read for the wizards' mount initializers. In-memory cache first
// (covers same-session reopen + any post-hydrate reload); then a best-effort
// synchronous localStorage read (covers a reload that beat the async
// IndexedDB hydrate, when localStorage happens to work). Returns
// { q2d, tidy3d } or null.
export function loadSectionWizardPrefs() {
  if (cache) return cache;
  const ls = safeLocalStorage();
  if (ls) {
    try {
      const raw = ls.getItem(SECTION_WIZARD_KEY);
      if (raw) {
        cache = normalize(JSON.parse(raw));
        return cache;
      }
    } catch { /* corrupt/blocked — rely on hydrate / in-memory cache */ }
  }
  return null;
}

// ASYNC hydrate from the durable IndexedDB store. Call once at app boot
// (main.jsx — orchestrator wiring) so a fresh reload restores the last-used
// values even when localStorage is unavailable. Idempotent; populates the
// in-memory cache WITHOUT clobbering a value already set this session.
export async function hydrateSectionWizardPrefs() {
  if (hydrated) return cache;
  hydrated = true;
  try {
    if (cache == null && typeof window !== 'undefined'
        && window.storage && typeof window.storage.get === 'function') {
      const raw = unwrap(await window.storage.get(SECTION_WIZARD_KEY));
      if (raw) cache = normalize(JSON.parse(raw));
    }
  } catch { /* durable store unavailable — fall back to localStorage / defaults */ }
  return cache;
}

// Persist on every change. `partial` is a per-wizard slice ({ q2d: {...} }
// and/or { tidy3d: {...} }); each slice merges PER-FIELD over the current
// stored values, so the Q2D wizard saving never resets the Tidy3D fields (or
// vice versa). Always updates the in-memory cache synchronously (the part
// that cannot fail), then writes through to IndexedDB (durable) and
// localStorage (best-effort) — both swallow errors so a blocked backend never
// breaks the wizard.
export function saveSectionWizardPrefs(partial) {
  const cur = loadSectionWizardPrefs() || emptyPrefs();
  const p = partial && typeof partial === 'object' ? partial : {};
  cache = {
    q2d: normQ2d({ ...cur.q2d, ...(p.q2d && typeof p.q2d === 'object' ? p.q2d : {}) }),
    tidy3d: normTidy3d({ ...cur.tidy3d, ...(p.tidy3d && typeof p.tidy3d === 'object' ? p.tidy3d : {}) }),
  };
  hydrated = true; // a real value now exists in memory; don't let a late hydrate overwrite it
  const json = JSON.stringify(cache);
  try {
    if (typeof window !== 'undefined' && window.storage && typeof window.storage.set === 'function') {
      Promise.resolve(window.storage.set(SECTION_WIZARD_KEY, json)).catch(() => {});
    }
  } catch { /* ignore */ }
  const ls = safeLocalStorage();
  if (ls) {
    try { ls.setItem(SECTION_WIZARD_KEY, json); } catch { /* blocked — cache+IDB hold it */ }
  }
  return true;
}

// ---------------------------------------------------------------------------
// defaultRoles — the shared signal/ground heuristic (pure; lives here, not in
// a .jsx file, so it unit-tests without a DOM).
//
// On a CPW-ish cross-section the ground pours dwarf the signal strip, so:
//   • every conductor with areaUm2 >= 0.8·maxArea → 'ground' (the big pours,
//     including near-ties from meshing/rounding noise);
//   • everything smaller → 'signal'.
// If that leaves NO signal (all areas comparable — e.g. a symmetric two-strip
// line, or a single conductor), the SMALLEST-area conductor flips to 'signal'
// (first in conductor order on an exact tie) so there is always something to
// excite. A single-conductor cross therefore comes out 'signal' — the
// "needs ≥2 conductors" failure is validation's job, not this default's.
// ---------------------------------------------------------------------------
export function defaultRoles(cross) {
  const conds = cross && Array.isArray(cross.conductors) ? cross.conductors : [];
  if (conds.length === 0) return {};
  // Zero-thickness (sheet) conductors have areaUm2 === 0 by construction
  // (z1 === z0), which degenerated the heuristic: 0 >= 0.8*0 made EVERY
  // sheet 'ground' and the no-signal fallback then flipped the FIRST-by-t
  // conductor — usually the ground pour — to signal (h_cond = 0 is the
  // primary TFLN/NbN workflow). Size sheets by their crossed WIDTH instead:
  // the biggest pour is still the natural ground.
  const sizeOf = (c) => {
    if (Number.isFinite(c.areaUm2) && c.areaUm2 > 0) return c.areaUm2;
    return (c.intervals || []).reduce((a, iv) => a + Math.max(0, iv.t1 - iv.t0), 0);
  };
  const areas = conds.map(sizeOf);
  const maxA = Math.max(...areas);
  const roles = {};
  conds.forEach((c, i) => { roles[c.id] = areas[i] >= 0.8 * maxA ? 'ground' : 'signal'; });
  if (!Object.values(roles).includes('signal')) {
    let minI = 0;
    areas.forEach((a, i) => { if (a < areas[minI]) minI = i; });
    roles[conds[minI].id] = 'signal';
  }
  return roles;
}
