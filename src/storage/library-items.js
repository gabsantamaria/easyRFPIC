// Library and archive item storage, plus bulk workspace import/export.
//
// "Library" items are reusable snippets the user can insert into any
// design. "Archive" items are library items the user has hidden but
// not deleted — they're recoverable via the panel. Both are stored
// per-workspace under their own prefixes.
//
// `exportWorkspace` / `importWorkspace` bundle the active workspace's
// designs, library items, and archive into a single JSON blob, which is
// what gets written to disk when a workspace is linked to a file handle.
//
// Extracted from PhotonicLayout.jsx as Stage 3.2 of the planned refactor.
import {
  libPrefix,
  archivePrefix,
  listSavedDesigns,
  loadDesign,
  saveDesign,
  deleteDesignStored,
} from './workspace.js';

// ----- Library storage -----
export async function listLibraryItems(workspace) {
  try {
    const prefix = libPrefix(workspace);
    const result = await window.storage.list(prefix);
    if (!result || !result.keys) return [];
    return result.keys
      .filter(k => {
        if (workspace) return true;
        const suffix = k.slice(prefix.length);
        return !suffix.includes(':');
      })
      .map(k => k.slice(prefix.length));
  } catch { return []; }
}
export async function listArchivedLibraryItems(workspace) {
  try {
    const prefix = archivePrefix(workspace);
    const result = await window.storage.list(prefix);
    if (!result || !result.keys) return [];
    return result.keys
      .filter(k => {
        if (workspace) return true;
        const suffix = k.slice(prefix.length);
        return !suffix.includes(':');
      })
      .map(k => k.slice(prefix.length));
  } catch { return []; }
}
export async function loadLibraryItem(workspace, name) {
  try {
    const r = await window.storage.get(libPrefix(workspace) + name);
    if (!r) return null;
    return JSON.parse(r.value);
  } catch { return null; }
}
export async function loadArchivedLibraryItem(workspace, name) {
  try {
    const r = await window.storage.get(archivePrefix(workspace) + name);
    if (!r) return null;
    return JSON.parse(r.value);
  } catch { return null; }
}
export async function saveLibraryItem(workspace, name, payload) {
  try {
    await window.storage.set(libPrefix(workspace) + name, JSON.stringify(payload));
    return true;
  } catch { return false; }
}
export async function saveArchivedLibraryItem(workspace, name, payload) {
  try {
    await window.storage.set(archivePrefix(workspace) + name, JSON.stringify(payload));
    return true;
  } catch { return false; }
}
export async function deleteLibraryItem(workspace, name) {
  try { await window.storage.delete(libPrefix(workspace) + name); return true; } catch { return false; }
}
export async function deleteArchivedLibraryItem(workspace, name) {
  try { await window.storage.delete(archivePrefix(workspace) + name); return true; } catch { return false; }
}

// ----- Bulk export / import -----
// Snapshot the entire workspace into a serializable bundle. Round-trips through JSON.
export async function exportWorkspace(workspace) {
  const designs = {};
  const designNames = await listSavedDesigns(workspace);
  for (const n of designNames) {
    const d = await loadDesign(workspace, n);
    if (d) designs[n] = d;
  }
  const lib = {};
  for (const n of await listLibraryItems(workspace)) {
    const d = await loadLibraryItem(workspace, n);
    if (d) lib[n] = d;
  }
  const archive = {};
  for (const n of await listArchivedLibraryItems(workspace)) {
    const d = await loadArchivedLibraryItem(workspace, n);
    if (d) archive[n] = d;
  }
  return {
    format: 'photonic_layout_workspace',
    version: 1,
    exportedAt: new Date().toISOString(),
    workspace,
    designs,
    library: lib,
    libraryArchive: archive,
  };
}

// Write a bundle into a workspace. mode = 'merge' (skip existing) | 'overwrite' | 'replace' (wipe first).
// Returns counts and a list of skipped names.
export async function importWorkspace(workspace, bundle, mode) {
  if (!bundle || bundle.format !== 'photonic_layout_workspace') {
    throw new Error('Not a workspace bundle (missing or wrong "format" field)');
  }
  const counts = { designs: 0, library: 0, archive: 0, skipped: [] };
  if (mode === 'replace') {
    for (const n of await listSavedDesigns(workspace)) await deleteDesignStored(workspace, n);
    for (const n of await listLibraryItems(workspace)) await deleteLibraryItem(workspace, n);
    for (const n of await listArchivedLibraryItems(workspace)) await deleteArchivedLibraryItem(workspace, n);
  }
  const existingDesigns = new Set(await listSavedDesigns(workspace));
  const existingLib = new Set(await listLibraryItems(workspace));
  const existingArch = new Set(await listArchivedLibraryItems(workspace));
  for (const [n, payload] of Object.entries(bundle.designs || {})) {
    if (mode === 'merge' && existingDesigns.has(n)) { counts.skipped.push(`design:${n}`); continue; }
    if (await saveDesign(workspace, n, payload)) counts.designs++;
  }
  for (const [n, payload] of Object.entries(bundle.library || {})) {
    if (mode === 'merge' && existingLib.has(n)) { counts.skipped.push(`library:${n}`); continue; }
    if (await saveLibraryItem(workspace, n, payload)) counts.library++;
  }
  for (const [n, payload] of Object.entries(bundle.libraryArchive || {})) {
    if (mode === 'merge' && existingArch.has(n)) { counts.skipped.push(`archive:${n}`); continue; }
    if (await saveArchivedLibraryItem(workspace, n, payload)) counts.archive++;
  }
  return counts;
}
