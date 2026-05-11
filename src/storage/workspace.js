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
// Where we remember the user's currently selected workspace.
export const WORKSPACE_KEY = 'photonic_layout::workspace';

export function designPrefix(workspace)  { return workspace ? `${BASE_DESIGN_PREFIX}${workspace}:`  : BASE_DESIGN_PREFIX; }
export function libPrefix(workspace)     { return workspace ? `${BASE_LIB_PREFIX}${workspace}:`     : BASE_LIB_PREFIX; }
export function archivePrefix(workspace) { return workspace ? `${BASE_ARCHIVE_PREFIX}${workspace}:` : BASE_ARCHIVE_PREFIX; }
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

export async function saveDesign(workspace, name, payload) {
  try {
    await window.storage.set(designPrefix(workspace) + name, JSON.stringify(payload));
    return true;
  } catch { return false; }
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
  for (const base of [BASE_DESIGN_PREFIX, BASE_LIB_PREFIX, BASE_ARCHIVE_PREFIX]) {
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
