// Workspace ↔ FOLDER mirroring (git-ready), via the File System Access API.
//
// Complements the single-FILE bundle mirror (file-handle.js): a workspace can
// additionally be linked to a DIRECTORY. On every successful persist the
// ACTIVE design is mirrored as individual files laid out for version control:
//
//   <dir>/workspace.json                          manifest (merge-updated)
//   <dir>/designs/<safeName>/current.json         working scene (rewritten;
//                                                 NO undo history — huge and
//                                                 noisy in diffs)
//   <dir>/designs/<safeName>/versions/vNNN_<id>.json
//                                                 one file PER SNAPSHOT,
//                                                 written ONCE (append-only —
//                                                 immutable snapshots diff
//                                                 cleanly in git and survive
//                                                 even browser-storage loss)
//   <dir>/.photonic/commit_msg                    latest snapshot's message,
//                                                 for `git commit -F`
//   <dir>/sync_git.sh                             generated once: add/commit/
//                                                 push helper (the browser
//                                                 cannot run git itself)
//
// WHY NOT isomorphic-git: push needs a CORS proxy + a PAT stored in browser
// storage — violating this project's credential-isolation rule — and an
// IDB-virtual repo would keep history inside the same evictable browser
// store the mirror exists to escape. The generated script (or the user's own
// git tooling / an fswatch hook) does the actual committing.
//
// PERMISSIONS: after a reload the persisted handle's permission downgrades to
// 'prompt', and requestPermission is auto-DENIED without a user gesture (the
// old file-link silently stopped mirroring this way — a real bug). Mirroring
// therefore only runs when queryPermission() is ALREADY 'granted'; otherwise
// the caller shows a one-click "re-authorize" banner whose click handler
// (gesture-scoped) calls requestDirPermission.
//
// Chromium-only (showDirectoryPicker); same envelope as the file link.

import { openHandleDB } from './file-handle.js';

export const dirPickerPresent = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

const HANDLE_STORE = 'workspace_handles';
const dirKey = (workspace) => `dir:${workspace || '__default__'}`;

export async function getWorkspaceDirHandle(workspace) {
  try {
    const db = await openHandleDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readonly');
      const req = tx.objectStore(HANDLE_STORE).get(dirKey(workspace));
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch { return null; }
}

export async function setWorkspaceDirHandle(workspace, handle) {
  try {
    const db = await openHandleDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readwrite');
      const store = tx.objectStore(HANDLE_STORE);
      const req = handle == null ? store.delete(dirKey(workspace)) : store.put(handle, dirKey(workspace));
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  } catch { return false; }
}

// 'granted' | 'prompt' | 'denied' | 'unavailable' — WITHOUT prompting.
export async function queryDirPermission(handle) {
  if (!handle) return 'unavailable';
  try { return await handle.queryPermission({ mode: 'readwrite' }); }
  catch { return 'unavailable'; }
}

// Gesture-scoped re-grant (call from a click handler ONLY — auto-denied otherwise).
export async function requestDirPermission(handle) {
  if (!handle) return false;
  try { return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted'; }
  catch { return false; }
}

// Filesystem-safe design directory name. Pure — exported for tests.
export function safeDesignDirName(name) {
  const cleaned = String(name || '').replace(/[^A-Za-z0-9._ -]+/g, '_').trim();
  return cleaned || 'design';
}

// Immutable per-snapshot filename: zero-padded versionNumber + id. Pure.
export function versionFileName(v) {
  const n = String(Math.max(0, Math.floor(v?.versionNumber ?? 0))).padStart(3, '0');
  const id = String(v?.id || 'unknown').replace(/[^a-z0-9]/gi, '').slice(0, 12) || 'unknown';
  return `v${n}_${id}.json`;
}

async function subdir(dirHandle, parts, create) {
  let d = dirHandle;
  for (const p of parts) d = await d.getDirectoryHandle(p, { create });
  return d;
}

async function writeFile(dirHandle, parts, filename, contents) {
  const d = await subdir(dirHandle, parts, true);
  const fh = await d.getFileHandle(filename, { create: true });
  const w = await fh.createWritable();
  await w.write(contents);
  await w.close();
}

async function fileExists(dirHandle, parts, filename) {
  try {
    const d = await subdir(dirHandle, parts, false);
    await d.getFileHandle(filename, { create: false });
    return true;
  } catch { return false; }
}

// Mirror ONE design (working scene + append-only snapshots + commit message +
// manifest touch) into the linked directory. NO permission prompting — the
// caller must have verified 'granted'. Returns { ok, wroteVersions } or
// { ok:false, error }.
export async function mirrorDesignToDir(dirHandle, workspace, name, payload) {
  try {
    const dirName = safeDesignDirName(name);
    const versions = Array.isArray(payload?.versions) ? payload.versions : [];
    // Working state — deliberately WITHOUT undo history/future.
    const current = {
      format: 'photonic-layout-design',
      version: 1,
      exportedAt: new Date().toISOString(),
      name,
      scene: payload?.scene ?? null,
      currentVersionId: payload?.currentVersionId ?? null,
    };
    await writeFile(dirHandle, ['designs', dirName], 'current.json', JSON.stringify(current, null, 2));
    // Snapshots: append-only — write each version file at most ONCE.
    let wroteVersions = 0;
    for (const v of versions) {
      if (!v || !v.id) continue;
      const fname = versionFileName(v);
      if (await fileExists(dirHandle, ['designs', dirName, 'versions'], fname)) continue;
      const doc = {
        format: 'photonic-layout-version', version: 1,
        design: name, id: v.id, versionNumber: v.versionNumber,
        description: v.description || '', savedAt: v.savedAt || null,
        scene: v.scene,
      };
      await writeFile(dirHandle, ['designs', dirName, 'versions'], fname, JSON.stringify(doc, null, 2));
      wroteVersions++;
    }
    // Commit message mirror: newest snapshot's description (git commit -F).
    const newest = versions.length ? versions.reduce((a, b) => ((b?.savedAt || 0) > (a?.savedAt || 0) ? b : a)) : null;
    const msg = newest
      ? `${name} v${newest.versionNumber}: ${newest.description || '(no description)'}`
      : `${name}: working state`;
    await writeFile(dirHandle, ['.photonic'], 'commit_msg', msg + '\n');
    // Manifest: merge this design's name in.
    let manifest = { format: 'photonic-layout-workspace-dir', version: 1, workspace: workspace || '', designs: [] };
    try {
      const d = await subdir(dirHandle, [], false);
      const fh = await d.getFileHandle('workspace.json', { create: false });
      const file = await fh.getFile();
      const parsed = JSON.parse(await file.text());
      if (parsed && Array.isArray(parsed.designs)) manifest = parsed;
    } catch { /* first write */ }
    if (!manifest.designs.includes(name)) manifest.designs.push(name);
    manifest.updatedAt = new Date().toISOString();
    await writeFile(dirHandle, [], 'workspace.json', JSON.stringify(manifest, null, 2));
    return { ok: true, wroteVersions };
  } catch (e) {
    return { ok: false, error: e };
  }
}

// One-time git helpers: the sync script (idempotent overwrite is fine — it's
// generated content) + a .git presence probe for the "git repo" badge.
export const SYNC_SCRIPT = `#!/bin/sh
# Generated by PhotonicLayout - commit the mirrored workspace to git.
# Run manually (sh sync_git.sh), or hook it to a watcher, e.g.:
#   fswatch -o .photonic/commit_msg | xargs -n1 -I{} sh sync_git.sh
cd "$(dirname "$0")" || exit 1
git add -A
if [ -s .photonic/commit_msg ]; then
  git commit -F .photonic/commit_msg
else
  git commit -m "photonic-layout sync"
fi
git push
`;

export async function writeGitSyncScript(dirHandle) {
  try {
    await writeFile(dirHandle, [], 'sync_git.sh', SYNC_SCRIPT);
    return true;
  } catch { return false; }
}

export async function dirHasGitRepo(dirHandle) {
  try {
    await dirHandle.getDirectoryHandle('.git', { create: false });
    return true;
  } catch { return false; }
}
