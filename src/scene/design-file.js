// Single-design file format (geometry only).
//
// A portable JSON file containing JUST the canvas scene — params,
// components, snaps, mirrors, groups, stack, cells, sim setup — and
// deliberately NOT the undo/redo history or the snapshot/version chain.
// This is the "hand someone the design" / "move it between browsers"
// file, distinct from the full workspace bundle (every design + library
// + versions) in src/storage/library-items.js.
//
// Pure transforms (no DOM, no storage) so they're unit-testable; the
// React handlers in PhotonicLayout.jsx own file I/O and state updates.
import { normalizeScene } from './schema.js';

export const DESIGN_FILE_FORMAT = 'photonic-layout-design';

// Build the export payload for the current scene. `exportedAt` is passed
// in (an ISO string) so this stays pure / deterministic for tests.
export function buildDesignExport(scene, name, exportedAt) {
  return {
    format: DESIGN_FILE_FORMAT,
    version: 1,
    name: name && String(name).trim() ? String(name).trim() : 'Untitled',
    exportedAt: exportedAt || null,
    scene: normalizeScene(scene),
  };
}

// Extract a normalized scene from a PARSED import file, ignoring any
// history / versions it may carry. Accepts three shapes:
//   - our export:    { format, scene }
//   - a full design: { scene, history, versions, ... }  → only .scene used
//   - a bare scene:  { components, params, ... }
// Returns { scene, name } on success or { error } (one of 'not-object',
// 'no-scene', 'normalize-failed' with an optional message).
export function parseDesignImport(parsed, fallbackName) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'not-object' };
  }
  const rawScene = (parsed.scene && typeof parsed.scene === 'object' && !Array.isArray(parsed.scene))
    ? parsed.scene
    : (Array.isArray(parsed.components) ? parsed : null);
  if (!rawScene || !Array.isArray(rawScene.components)) {
    return { error: 'no-scene' };
  }
  let scene;
  try {
    scene = normalizeScene(rawScene);
  } catch (e) {
    return { error: 'normalize-failed', message: e?.message || String(e) };
  }
  const name = (parsed.name && String(parsed.name).trim())
    || (fallbackName && String(fallbackName).trim())
    || 'Imported design';
  return { scene, name };
}

// Filesystem-safe filename for a design export (no extension).
export function designExportFilename(name, dateStr) {
  const safe = (name && String(name).replace(/[^A-Za-z0-9._-]+/g, '_')) || 'design';
  const base = safe || 'design';
  return dateStr ? `${base}_${dateStr}` : base;
}
