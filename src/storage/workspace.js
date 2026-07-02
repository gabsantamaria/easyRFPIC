// Workspace + design storage built on top of the host-provided
// `window.storage` text-KV API.
//
// All app data lives under three prefixes (designs / library / archive).
// A "workspace" is a user-chosen folder/namespace appended to the base
// prefix so the user can keep separate sets of designs (e.g. "personal",
// "client-A", "thesis").
//
// Empty workspace ("") = the default namespace, matching pre-workspace
// storage keys so existing saved data remains accessible.
//
// Extracted from PhotonicLayout.jsx as Stage 3.2 of the planned refactor.

export const BASE_DESIGN_PREFIX  = 'photonic_layout:';
export const BASE_LIB_PREFIX     = 'photonic_layout_lib:';
export const BASE_ARCHIVE_PREFIX = 'photonic_layout_lib_archive:';
// Parametric cell definitions (define once / instantiate many) — stored
// per-workspace exactly like library items.
export const BASE_CELL_PREFIX    = 'photonic_layout_cells:';
// Where we remember the user's currently selected workspace.
export const WORKSPACE_KEY = 'photonic_layout::workspace';

export function designPrefix(workspace)  { return workspace ? `${BASE_DESIGN_PREFIX}${workspace}:`  : BASE_DESIGN_PREFIX; }
export function libPrefix(workspace)     { return workspace ? `${BASE_LIB_PREFIX}${workspace}:`     : BASE_LIB_PREFIX; }
export function archivePrefix(workspace) { return workspace ? `${BASE_ARCHIVE_PREFIX}${workspace}:` : BASE_ARCHIVE_PREFIX; }
export function cellPrefix(workspace)    { return workspace ? `${BASE_CELL_PREFIX}${workspace}:`    : BASE_CELL_PREFIX; }
export function activeDesignKey(workspace) { return designPrefix(workspace) + '_active'; }

export async function listSavedDesigns(workspace) {
  try {
    const prefix = designPrefix(workspace);
    const result = await window.storage.list(prefix);
    if (!result || !result.keys) return [];
    // For the empty workspace, the list also returns workspace-scoped keys
    // (since they all share the base prefix). Filter those out.
    return result.keys
      .filter(k => k !== activeDesignKey(workspace) && !k.startsWith(prefix + '_'))
      .filter(k => {
        if (workspace) return true;
        // For the default workspace, exclude keys that look like another workspace,
        // i.e. "photonic_layout:<workspace>:..." with a colon in the suffix.
        const suffix = k.slice(prefix.length);
        return !suffix.includes(':');
      })
      .map(k => k.slice(prefix.length));
  } catch { return []; }
}

export async function loadDesign(workspace, name) {
  try {
    const r = await window.storage.get(designPrefix(workspace) + name);
    if (!r) return null;
    return JSON.parse(r.value);
  } catch { return null; }
}

// A design name that will round-trip through storage AND appear in every
// list. Names starting with '_' are reserved for internals (listSavedDesigns
// filters `prefix + '_'` — e.g. the `_active` pointer and `_clipboard`), and
// ':' is the workspace prefix separator (a name containing it vanishes from
// the default workspace's list and can shadow another workspace's keys).
// Without this check such names SAVE fine and then never show up anywhere —
// an invisible-loss trap. Returns { ok: true, name } (trimmed) or
// { ok: false, reason }.
export function validateDesignName(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return { ok: false, reason: 'Design name cannot be empty.' };
  if (trimmed.startsWith('_')) return { ok: false, reason: 'Design name cannot start with "_" (reserved for internal keys).' };
  if (trimmed.includes(':')) return { ok: false, reason: 'Design name cannot contain ":" (used as the workspace separator).' };
  return { ok: true, name: trimmed };
}

// Sanitize an arbitrary (e.g. imported) name into a valid one rather than
// rejecting it: strip leading underscores, replace ':' with '-'.
export function sanitizeDesignName(name) {
  const cleaned = (name || '').trim().replace(/^_+/, '').replace(/:/g, '-').trim();
  return cleaned || 'Imported design';
}

// Detect a storage-quota error across browsers. Chrome/Safari throw a
// DOMException named "QuotaExceededError" (code 22); Firefox throws
// "NS_ERROR_DOM_QUOTA_REACHED" (code 1014). Match on name/message/code so
// the caller can give quota-specific guidance.
function isQuotaError(e) {
  if (!e) return false;
  const name = e.name || '';
  const msg = e.message || '';
  return /quota/i.test(name) || /quota|exceeded the/i.test(msg) || e.code === 22 || e.code === 1014;
}

// Save a design's payload under its name. Returns a STRUCTURED result so
// callers can report WHY a save failed instead of a bare boolean that
// swallows the real error:
//   success → { ok: true, bytes }
//   failure → { ok: false, phase: 'serialize' | 'write', error, name,
//               message, bytes?, breakdown?, isQuota }
// `breakdown` (write failures) reports the serialized size of each payload
// part — history / future / versions usually dominate a bloated design and
// explain a quota failure. Pair with describeSaveFailure() for the message.
// `opts.mergeVersions` (default true): before writing, union the payload's
// versions[] with any snapshots ALREADY IN STORAGE that the payload doesn't
// carry (by id). Design payloads are whole-blob writes, so a tab holding a
// stale versions[] (another tab took snapshots since this one loaded) would
// otherwise silently ERASE those snapshots on its next autosave — the
// multi-tab last-writer-wins data-loss class. Snapshots are immutable, so a
// union by id is always safe; the payload's copy wins on id collision (that
// keeps description edits). Pass { mergeVersions: false } ONLY when the
// caller is deliberately REMOVING a version (delete-version), else the
// merge would resurrect it.
export async function saveDesign(workspace, name, payload, opts = {}) {
  if (opts.mergeVersions !== false && payload && Array.isArray(payload.versions)) {
    try {
      const existing = await loadDesign(workspace, name);
      const stored = existing && Array.isArray(existing.versions) ? existing.versions : [];
      if (stored.length > 0) {
        const have = new Set(payload.versions.map((v) => v && v.id).filter(Boolean));
        const missing = stored.filter((v) => v && v.id && !have.has(v.id));
        if (missing.length > 0) {
          const merged = [...payload.versions, ...missing]
            .sort((a, b) => (b?.savedAt || 0) - (a?.savedAt || 0));
          payload = { ...payload, versions: merged };
        }
      }
    } catch { /* merge is best-effort; the write proceeds with the payload as-is */ }
  }
  let json;
  try {
    json = JSON.stringify(payload);
  } catch (e) {
    return { ok: false, phase: 'serialize', error: e, name: e?.name || 'Error', message: e?.message || String(e) };
  }
  try {
    await window.storage.set(designPrefix(workspace) + name, json);
    return { ok: true, bytes: json.length };
  } catch (e) {
    const breakdown = {};
    try {
      if (payload && typeof payload === 'object') {
        if (payload.scene !== undefined) breakdown.sceneBytes = JSON.stringify(payload.scene).length;
        if (Array.isArray(payload.history)) { breakdown.historyBytes = JSON.stringify(payload.history).length; breakdown.historyCount = payload.history.length; }
        if (Array.isArray(payload.future)) { breakdown.futureBytes = JSON.stringify(payload.future).length; breakdown.futureCount = payload.future.length; }
        if (Array.isArray(payload.versions)) { breakdown.versionsBytes = JSON.stringify(payload.versions).length; breakdown.versionCount = payload.versions.length; }
      }
    } catch { /* size breakdown is best-effort */ }
    return {
      ok: false, phase: 'write', error: e,
      name: e?.name || 'Error', message: e?.message || String(e),
      bytes: json.length, breakdown, isQuota: isQuotaError(e),
    };
  }
}

// Build a human-readable, actionable message from a FAILED saveDesign
// result (the object returned when ok === false). Returns '' for a
// successful or missing result.
export function describeSaveFailure(result) {
  if (!result || result.ok) return '';
  const mb = (n) => `${(n / (1024 * 1024)).toFixed(2)} MB`;
  if (result.phase === 'serialize') {
    return `Could not serialize the design before saving.\n${result.name}: ${result.message}\n\n`
      + "This usually means the scene contains a value that can't be saved as JSON "
      + '(a circular reference or a non-plain object). Undo the last change and try again.';
  }
  const lines = [`${result.name || 'Error'}: ${result.message}`];
  if (typeof result.bytes === 'number') lines.push(`Payload size: ~${mb(result.bytes)}.`);
  const b = result.breakdown || {};
  if (typeof b.sceneBytes === 'number') {
    const parts = [`scene ${mb(b.sceneBytes)}`];
    if (typeof b.historyBytes === 'number') parts.push(`undo history ${mb(b.historyBytes)} (${b.historyCount} steps)`);
    if (typeof b.futureBytes === 'number') parts.push(`redo ${mb(b.futureBytes)} (${b.futureCount} steps)`);
    if (typeof b.versionsBytes === 'number') parts.push(`snapshots ${mb(b.versionsBytes)} (${b.versionCount})`);
    lines.push(`Breakdown: ${parts.join(', ')}.`);
  }
  if (result.isQuota) {
    lines.push('');
    lines.push("Cause: the browser's local-storage quota is full. It is ~5 MB per site and is SHARED "
      + 'across every design, snapshot, the library, and the archive in this browser — so one large '
      + 'design (or many snapshots) can fill it.');
    lines.push('');
    lines.push('Fixes:');
    lines.push('  • Link this workspace to a file on disk (the workspace button in the header) — that path has no size limit.');
    lines.push('  • Delete snapshots you no longer need (each snapshot stores a full copy of the scene).');
    lines.push('  • Delete or export old designs to free space.');
  }
  return lines.join('\n');
}

export async function deleteDesignStored(workspace, name) {
  try { await window.storage.delete(designPrefix(workspace) + name); return true; } catch { return false; }
}

export async function setActiveDesignName(workspace, name) {
  try { await window.storage.set(activeDesignKey(workspace), JSON.stringify({ name })); } catch {}
}

export async function getActiveDesignName(workspace) {
  try {
    const r = await window.storage.get(activeDesignKey(workspace));
    if (!r) return null;
    return JSON.parse(r.value).name;
  } catch { return null; }
}

// Workspace selection persists across sessions (independent of workspace).
export async function getStoredWorkspace() {
  try {
    const r = await window.storage.get(WORKSPACE_KEY);
    if (!r) return '';
    return JSON.parse(r.value).name || '';
  } catch { return ''; }
}
export async function setStoredWorkspace(name) {
  try { await window.storage.set(WORKSPACE_KEY, JSON.stringify({ name: name || '' })); return true; } catch { return false; }
}

// Discover every workspace that has any data stored. Returns sorted list including ''
// (the default) if it has any keys.
export async function discoverWorkspaces() {
  const ws = new Set();
  let hasDefault = false;
  for (const base of [BASE_DESIGN_PREFIX, BASE_LIB_PREFIX, BASE_ARCHIVE_PREFIX, BASE_CELL_PREFIX]) {
    try {
      const r = await window.storage.list(base);
      if (!r || !r.keys) continue;
      for (const k of r.keys) {
        const suffix = k.slice(base.length);
        const colon = suffix.indexOf(':');
        if (colon === -1) {
          // Default-workspace key (no nested colon)
          if (!suffix.startsWith('_')) hasDefault = true;
        } else {
          ws.add(suffix.slice(0, colon));
        }
      }
    } catch {}
  }
  const out = [...ws].sort();
  if (hasDefault) out.unshift('');
  return out;
}
