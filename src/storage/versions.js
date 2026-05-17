// Design-version helpers.
//
// A saved design's payload is:
//   {
//     scene,         // current working state
//     history,       // undo stack for current state
//     future,        // redo stack for current state
//     updatedAt,     // timestamp of last Save (to current)
//     versions?: [   // snapshot history (newest FIRST)
//       {
//         id: 'a3f2d8c1',          // 8-hex unique id (like a git SHA)
//         versionNumber: 3,         // monotonic counter, starts at 1
//         description: 'pre-port',  // user-provided "commit" message
//         scene,                    // FROZEN snapshot
//         savedAt: <ms epoch>,      // creation timestamp
//       },
//       ...
//     ]
//   }
//
// A "Save" updates scene/history/future/updatedAt; versions stay
// untouched (you're saving to the "current" / working state).
// A "Snapshot" appends a new entry to versions[] capturing the
// current scene at that moment.
//
// Legacy payloads (no `versions` field) load fine — we treat them
// as having zero version history.

// Generate a short hex-ish id, similar to abbreviated git SHAs. 8
// chars × 4 bits = 32 bits of entropy → collision probability is
// vanishingly small at typical scales (hundreds of versions per
// design). We retry if a randomly-generated id happens to collide
// with an existing one — see ensureUniqueVersionId.
export function generateVersionId() {
  // Use crypto.getRandomValues when available (browser + Node.js >= 19),
  // fall back to Math.random for ancient environments.
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const buf = new Uint8Array(4);
    crypto.getRandomValues(buf);
    return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
}

// Re-roll the random id until it doesn't collide with any existing
// version id in the array. Worth doing because the random ids are
// what the user / git-style refs use to identify a specific version.
export function ensureUniqueVersionId(versions) {
  const used = new Set((versions || []).map(v => v.id));
  for (let i = 0; i < 16; i++) {
    const id = generateVersionId();
    if (!used.has(id)) return id;
  }
  // Astronomically unlikely 16 collisions in a row — fall back to a
  // timestamp-derived id to guarantee uniqueness.
  return Date.now().toString(16).padStart(8, '0').slice(-8);
}

// Next monotonic version number (1-based).
export function nextVersionNumber(versions) {
  if (!Array.isArray(versions) || versions.length === 0) return 1;
  let max = 0;
  for (const v of versions) {
    if (Number.isFinite(v?.versionNumber) && v.versionNumber > max) max = v.versionNumber;
  }
  return max + 1;
}

// Build a new version object capturing a scene snapshot. The scene
// is DEEP-CLONED so subsequent edits to the working state don't
// mutate the frozen snapshot.
export function makeVersion(scene, description, versions) {
  const cloneScene = (s) => JSON.parse(JSON.stringify(s));
  return {
    id: ensureUniqueVersionId(versions),
    versionNumber: nextVersionNumber(versions),
    description: (description || '').slice(0, 240), // soft cap for sanity
    scene: cloneScene(scene),
    savedAt: Date.now(),
  };
}

// Convenience: pull a stable, sorted array of versions for display
// (most-recent SAVED first). Tolerates missing `versions` and bad
// entries; never throws.
export function sortedVersions(versions) {
  if (!Array.isArray(versions)) return [];
  return [...versions]
    .filter(v => v && typeof v === 'object' && typeof v.id === 'string')
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

// Look up a version by id; returns null if not found.
export function findVersionById(versions, id) {
  if (!Array.isArray(versions) || !id) return null;
  return versions.find(v => v && v.id === id) || null;
}
