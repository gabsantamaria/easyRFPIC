// Install a `window.storage` implementation when the host doesn't provide
// one of its own.
//
// The storage modules under src/storage/{workspace,library-items}.js call
// `window.storage.{get,set,delete,list}` — an interface the app
// originally inherited from the Claude artifacts viewer, which injects it
// as a host capability. When running under `vite dev` / `vite build` in a
// regular browser there's no host injection, so we install our own.
//
// Backend priority:
//   1. IndexedDB  — the default. Hundreds of MB to GBs of quota (browser-
//      dependent: typically a large fraction of free disk), vs the ~5 MB
//      cap localStorage imposes PER ORIGIN across every design + snapshot
//      + library + archive combined. This is what keeps large designs and
//      long snapshot histories from hitting "save failed".
//   2. localStorage — fallback if IndexedDB is unavailable (some locked-
//      down policies / very old engines). Keeps persistence working,
//      just with the old ~5 MB cap.
//   3. in-memory  — last resort (Safari Private Mode with both disabled,
//      etc.); the app runs but nothing survives a reload.
//
// On first run with the IndexedDB backend we MIGRATE existing
// `photonic_layout*` keys out of localStorage so no saved design / library
// / workspace is lost in the switch. Migration COPIES (never deletes) the
// localStorage entries, so the old data stays as a safety net. The AI
// settings key (`photonic_layout_ai_settings`) is deliberately left in
// localStorage — it's the user's API key and must never be relocated into
// shared design storage (see src/ai/settings.js).
//
// `window.storage`'s methods are async and lazily open the backend on
// first use, so installStorageShim() can stay synchronous (it must run
// before React mounts) while the IndexedDB connection opens in the
// background. We install only if `window.storage` isn't already present,
// so a host that DOES provide its own implementation wins.

const IDB_NAME = 'photonic_layout';
const IDB_STORE = 'kv';
const MIGRATION_FLAG = '__photonic_migrated_from_localstorage_v1__';
// Keys under these prefixes are app storage and get migrated. The AI
// settings key shares the `photonic_layout` prefix but is excluded.
const MIGRATE_PREFIX = 'photonic_layout';
const MIGRATE_EXCLUDE = new Set(['photonic_layout_ai_settings']);

function openIDB() {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(IDB_NAME, 1);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    // Another tab is mid-upgrade; it resolves once that tab closes the
    // connection. We don't reject — just wait for onsuccess/onerror.
    req.onblocked = () => {};
  });
}

// Run one IndexedDB request inside a fresh transaction and resolve with
// its result. Rejects on request error OR transaction abort (the abort
// path is how a write that exceeds even IndexedDB's (much larger) quota
// surfaces — it propagates up to saveDesign's structured error).
function idbDo(db, mode, fn) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(IDB_STORE, mode);
    } catch (e) {
      reject(e);
      return;
    }
    let req;
    try {
      req = fn(tx.objectStore(IDB_STORE));
    } catch (e) {
      reject(e);
      return;
    }
    req.onsuccess = () => resolve(req.result);
    req.onerror = (ev) => { ev.stopPropagation?.(); reject(req.error); };
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

function makeIdbBackend(db) {
  return {
    get: (key) => idbDo(db, 'readonly', (s) => s.get(key)),
    set: (key, value) => idbDo(db, 'readwrite', (s) => s.put(value, key)),
    delete: (key) => idbDo(db, 'readwrite', (s) => s.delete(key)),
    keys: () => idbDo(db, 'readonly', (s) => s.getAllKeys()),
  };
}

// Copy existing photonic_layout* localStorage entries into `backend` once,
// gated by a flag stored in the backend itself so it never re-runs (which
// would overwrite fresh IndexedDB data with stale localStorage). Best-
// effort: any failure is logged and swallowed so a migration hiccup can't
// break app startup.
async function migrateFromLocalStorage(backend) {
  try {
    if (await backend.get(MIGRATION_FLAG)) return;
  } catch {
    return; // can't read the flag — skip migration rather than risk dupes
  }
  let migrated = 0;
  try {
    if (typeof localStorage !== 'undefined') {
      const toCopy = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k == null || !k.startsWith(MIGRATE_PREFIX) || MIGRATE_EXCLUDE.has(k)) continue;
        const v = localStorage.getItem(k);
        if (v != null) toCopy.push([k, v]);
      }
      for (const [k, v] of toCopy) { await backend.set(k, v); migrated++; }
    }
  } catch (e) {
    console.warn('photonic-layout: localStorage → IndexedDB migration failed (continuing):', e);
  }
  try { await backend.set(MIGRATION_FLAG, '1'); } catch { /* flag write best-effort */ }
  if (migrated > 0) {
    console.info(`photonic-layout: migrated ${migrated} item(s) from localStorage to IndexedDB.`);
  }
}

function makeLocalStorageBackend() {
  // Round-trip a sentinel to confirm localStorage is actually writable
  // (Safari Private Browsing etc. expose the API but throw on set).
  const sentinel = '__photonic_layout_storage_probe__';
  window.localStorage.setItem(sentinel, '1');
  window.localStorage.removeItem(sentinel);
  return {
    keys: () => {
      const out = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k != null) out.push(k);
      }
      return out;
    },
    get: (key) => window.localStorage.getItem(key),
    set: (key, value) => window.localStorage.setItem(key, value),
    delete: (key) => window.localStorage.removeItem(key),
  };
}

function makeMemoryBackend() {
  const mem = new Map();
  return {
    keys: () => Array.from(mem.keys()),
    get: (key) => (mem.has(key) ? mem.get(key) : null),
    set: (key, value) => { mem.set(key, value); },
    delete: (key) => { mem.delete(key); },
  };
}

// Resolve the best available backend, running migration for IndexedDB.
// Returns an object exposing async-or-sync { get, set, delete, keys }.
async function initBackend() {
  // 1) IndexedDB — the high-capacity default.
  if (typeof indexedDB !== 'undefined') {
    try {
      const db = await openIDB();
      const backend = makeIdbBackend(db);
      await migrateFromLocalStorage(backend);
      return backend;
    } catch (e) {
      console.warn('photonic-layout: IndexedDB unavailable; falling back to localStorage (~5 MB cap).', e);
    }
  }
  // 2) localStorage — preserves the previous behavior.
  try {
    return makeLocalStorageBackend();
  } catch {
    // 3) in-memory — app runs, nothing persists.
    console.warn('photonic-layout: no persistent storage available; this session will not be saved.');
    return makeMemoryBackend();
  }
}

export function installStorageShim() {
  if (typeof window === 'undefined') return; // SSR / Node
  if (window.storage) return;                // host-provided wins

  // Memoized backend init — every storage call awaits the same promise,
  // so concurrent first-use calls share one IndexedDB open + migration.
  let backendPromise = null;
  const backend = () => (backendPromise ||= initBackend());

  window.storage = {
    async list(prefix) {
      const b = await backend();
      const keys = (await b.keys()).filter((k) => k.startsWith(prefix));
      return { keys };
    },
    async get(key) {
      const b = await backend();
      const v = await b.get(key);
      return v == null ? null : { value: v };
    },
    async set(key, value) {
      const b = await backend();
      await b.set(key, value);
    },
    async delete(key) {
      const b = await backend();
      await b.delete(key);
    },
  };
}

// Back-compat alias: main.jsx historically imported installLocalStorageShim.
// The shim is no longer localStorage-specific (IndexedDB is the default),
// but keep the old name working for any external caller.
export const installLocalStorageShim = installStorageShim;
