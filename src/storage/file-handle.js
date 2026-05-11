// File System Access API + IndexedDB integration for workspace ↔ disk
// linking.
//
// Each workspace can optionally be bound to a JSON file on disk via the
// File System Access API. The browser returns a FileSystemFileHandle
// which we persist in IndexedDB (NOT in window.storage, which is
// text-only). On every successful design save, if the active workspace
// has a linked handle, we ALSO rewrite the entire workspace bundle to
// that file. This gives the user a single source of truth that
// auto-mirrors browser-side state to disk.
//
// File System Access API is not available in all browsers (Safari,
// Firefox) AND is blocked in cross-origin sandboxed iframes (artifacts
// viewers, embedded previews, etc.). The presence of `showSaveFilePicker`
// on `window` is necessary but NOT sufficient: a sandboxed iframe still
// throws "Cross origin sub frames aren't allowed to show a file picker"
// at call time. We can't detect that ahead of time, so the actual link
// handler tries and catches it, then sets `fsBlockedAtRuntime` so the UI
// reflects the restriction without further user-visible failures.
//
// Extracted from PhotonicLayout.jsx as Stage 3.2 of the planned refactor.

export const fsAccessAPIPresent = typeof window !== 'undefined' && 'showSaveFilePicker' in window;

const HANDLE_DB_NAME = 'photonic_layout_handles';
const HANDLE_STORE   = 'workspace_handles';

export function openHandleDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HANDLE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) {
        db.createObjectStore(HANDLE_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getWorkspaceHandle(workspace) {
  try {
    const db = await openHandleDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readonly');
      const store = tx.objectStore(HANDLE_STORE);
      const req = store.get(workspace || '__default__');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch { return null; }
}

export async function setWorkspaceHandle(workspace, handle) {
  try {
    const db = await openHandleDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readwrite');
      const store = tx.objectStore(HANDLE_STORE);
      const req = handle == null
        ? store.delete(workspace || '__default__')
        : store.put(handle, workspace || '__default__');
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  } catch { return false; }
}

// Verify (and re-request, if needed) that we can WRITE to the linked handle.
// Browser may revoke the permission across sessions; this re-asks.
export async function ensureWritePermission(handle) {
  if (!handle) return false;
  try {
    const opts = { mode: 'readwrite' };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if ((await handle.requestPermission(opts)) === 'granted') return true;
    return false;
  } catch { return false; }
}

// Write a workspace bundle (the entire designs/library/archive tree) to a
// FileSystemFileHandle. Returns true on success.
export async function writeBundleToHandle(handle, bundle) {
  try {
    const ok = await ensureWritePermission(handle);
    if (!ok) return false;
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(bundle, null, 2));
    await writable.close();
    return true;
  } catch (e) {
    console.error('writeBundleToHandle error:', e);
    return false;
  }
}
