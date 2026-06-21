// 2-line method wizard — last-used field values.
//
// Stored ONLY in the browser's localStorage under a key that is NOT one of the
// workspace storage prefixes, so the values can never ride along in a design
// export, a workspace export/import bundle, or a generated script (same
// isolation rationale as the AI key + app settings). Persisted on Generate;
// restored when the wizard opens. Global (not per-workspace) — a restored
// lengthParam that doesn't exist in the current design falls back to the first
// parameter, and L1/L2 are freely editable, so a stale value is harmless.

const KEY = 'photonic_layout_two_line';

// Returns the saved prefs (all string-valued) or null if none/invalid.
export function loadTwoLinePrefs() {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
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
    };
  } catch {
    return null;
  }
}

export function saveTwoLinePrefs(prefs) {
  try {
    const p = prefs || {};
    window.localStorage.setItem(KEY, JSON.stringify({
      lengthParam: p.lengthParam || '',
      l1: p.l1 || '',
      l2: p.l2 || '',
      separation: p.separation || '',
      freqStart: p.freqStart || '',
      freqStop: p.freqStop || '',
      freqPoints: p.freqPoints || '',
    }));
    return true;
  } catch {
    return false;
  }
}
