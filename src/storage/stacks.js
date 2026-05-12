// Per-workspace library of layer stacks.
//
// Each saved stack is keyed under `photonic_layout_stack:<workspace>:<name>`
// and stores `{ name, stack: [...layers] }`. Stacks are independent of
// designs — saving a design captures its current stack inline, but the
// stack library lets the user pull a known stack into ANY design.
//
// Mirrors the workspace.js / library-items.js pattern: workspace-aware
// prefix, host-provided (or shimmed) window.storage as the backing
// store, try/catch on every entry point so corrupt or missing data
// can't crash the panel.

const BASE_STACK_PREFIX = 'photonic_layout_stack:';

function stackPrefix(workspace) {
  return workspace ? `${BASE_STACK_PREFIX}${workspace}:` : BASE_STACK_PREFIX;
}

export async function listStacks(workspace) {
  try {
    const prefix = stackPrefix(workspace);
    const result = await window.storage.list(prefix);
    if (!result || !result.keys) return [];
    return result.keys
      .filter((k) => {
        if (workspace) return true;
        // Default workspace: exclude keys with a nested colon (those
        // belong to a named workspace under the base prefix).
        const suffix = k.slice(prefix.length);
        return !suffix.includes(':');
      })
      .map((k) => k.slice(prefix.length));
  } catch {
    return [];
  }
}

export async function loadStack(workspace, name) {
  try {
    const r = await window.storage.get(stackPrefix(workspace) + name);
    if (!r) return null;
    const payload = JSON.parse(r.value);
    // Tolerate older payloads that were the raw stack array, not a
    // { name, stack } wrapper.
    if (Array.isArray(payload)) return { name, stack: payload };
    return payload;
  } catch {
    return null;
  }
}

export async function saveStack(workspace, name, payload) {
  try {
    await window.storage.set(stackPrefix(workspace) + name, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export async function deleteStack(workspace, name) {
  try {
    await window.storage.delete(stackPrefix(workspace) + name);
    return true;
  } catch {
    return false;
  }
}
