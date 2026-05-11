// Row components used inside the Library panel:
//   - WorkspaceCreateRow: free-typed workspace-name input + switch button.
//   - LibraryItemRow:     one entry in the library list (rename, insert,
//                         archive).
//
// Extracted from PhotonicLayout.jsx as Stage 4.4 of the planned refactor.
import React, { useState, useEffect } from 'react';
import { Package, Pencil, Boxes } from 'lucide-react';

export function WorkspaceCreateRow({ currentWorkspace, onSwitch }) {
  const [draft, setDraft] = useState('');
  const submit = () => {
    if (draft === currentWorkspace) return;
    onSwitch(draft);
    setDraft('');
  };
  return (
    <div className="flex items-center gap-1">
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        placeholder="workspace name (empty = default)"
        className="flex-1 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-cyan-300 outline-none focus:border-cyan-400"
        spellCheck={false}
      />
      <button
        onClick={submit}
        className="px-2 py-1 rounded text-xs font-medium"
        style={{ background: '#22c55e', color: '#0f172a' }}
      >
        switch / create
      </button>
    </div>
  );
}

export function LibraryItemRow({ name, onInsert, onArchive, onRename }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  useEffect(() => { if (!editing) setDraft(name); }, [name, editing]);
  const commit = () => {
    const trimmed = draft.trim();
    setEditing(false);
    if (trimmed && trimmed !== name) onRename(trimmed);
    else setDraft(name);
  };
  return (
    <div className="rounded border border-slate-700 px-2 py-1.5 flex items-center gap-2" style={{ background: '#1e293b' }}>
      <Package size={11} className="text-cyan-400 flex-shrink-0" />
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.target.blur();
            if (e.key === 'Escape') { setDraft(name); setEditing(false); }
          }}
          className="font-mono text-xs flex-1 min-w-0 bg-slate-900 border border-cyan-600 rounded px-1 py-0.5 text-slate-100 outline-none"
          spellCheck={false}
        />
      ) : (
        <span
          className="font-mono text-xs text-slate-200 flex-1 truncate cursor-text hover:text-cyan-200"
          onDoubleClick={() => setEditing(true)}
          title="Double-click to rename"
        >
          {name}
        </span>
      )}
      <button onClick={() => setEditing(true)} className="text-slate-500 hover:text-cyan-400" title="Rename">
        <Pencil size={10} />
      </button>
      <button onClick={onInsert} className="text-[10px] px-2 py-0.5 rounded bg-cyan-700 hover:bg-cyan-600 text-white" title="Insert into scene">
        insert
      </button>
      <button onClick={onArchive} className="text-slate-500 hover:text-amber-400" title="Archive (can be restored later)">
        <Boxes size={11} />
      </button>
    </div>
  );
}
