// One group row in the SHAPES tree. Expands to show its member components
// (rendered via the renderCompRow callback so the parent decides how each
// component appears) plus any parameter aliases the group introduces.
//
// Extracted from PhotonicLayout.jsx as Stage 4.8 of the planned refactor.
import React, { useState, useEffect } from 'react';
import { FolderTree, Trash2 } from 'lucide-react';

export function GroupTreeItem({ group, components, params, selectedIds, onSelectGroup, onDissolve, onDelete, onRename, renderCompRow }) {
  const [expanded, setExpanded] = useState(true);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(group.name);
  useEffect(() => { setNameDraft(group.name); }, [group.name]);
  const memberComps = group.memberIds.map(id => components.find(c => c.id === id)).filter(Boolean);
  const aliasEntries = Object.entries(group.aliases || {});
  const allSelected = memberComps.length > 0 && memberComps.every(c => selectedIds.has(c.id));

  const commitName = () => {
    const trimmed = nameDraft.trim();
    setEditingName(false);
    if (trimmed && trimmed !== group.name) onRename?.(trimmed);
    else setNameDraft(group.name);
  };

  return (
    <div className={`rounded border ${allSelected ? 'border-violet-500' : 'border-violet-700/40'}`} style={{ background: 'rgba(124,58,237,0.06)' }}>
      <div className="flex items-center justify-between gap-1 px-2 py-1 border-b border-violet-700/30">
        <button onClick={() => setExpanded(e => !e)} className="text-slate-400 hover:text-slate-200 text-xs flex-shrink-0 w-4">
          {expanded ? '▾' : '▸'}
        </button>
        <FolderTree size={11} className="text-violet-400 flex-shrink-0" />
        {editingName ? (
          <input
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.target.blur();
              if (e.key === 'Escape') { setNameDraft(group.name); setEditingName(false); }
            }}
            className="font-mono font-bold text-[11px] text-violet-100 bg-slate-900 border border-violet-500 rounded px-1 py-0 flex-1 min-w-0 outline-none"
            spellCheck={false}
          />
        ) : (
          <button
            onClick={onSelectGroup}
            onDoubleClick={() => setEditingName(true)}
            className="font-mono font-bold text-[11px] text-violet-300 hover:text-violet-100 flex-1 text-left truncate"
            title="Click to select all members · double-click to rename"
          >
            {group.name}
          </button>
        )}
        <button onClick={() => setEditingName(true)} className="text-slate-500 hover:text-violet-300 text-[10px] px-1" title="Rename group (also renames its parameters)">
          rename
        </button>
        <span className="text-[9px] text-slate-500">{memberComps.length}</span>
        <button onClick={onDissolve} className="text-slate-500 hover:text-amber-400 text-[10px] px-1" title="Ungroup — keep components and parameters, remove only the group">
          ungroup
        </button>
        <button onClick={onDelete} className="text-slate-500 hover:text-red-400" title="Delete group AND all its components">
          <Trash2 size={10} />
        </button>
      </div>
      {expanded && (
        <div className="p-1 space-y-1">
          {memberComps.map(c => renderCompRow(c))}
          {aliasEntries.length > 0 && (
            <div className="mt-1 pt-1 border-t border-violet-700/20">
              <p className="text-[9px] uppercase tracking-wider text-slate-600 px-1 mb-0.5">aliases</p>
              {aliasEntries.map(([orig, aliased]) => (
                <div key={orig} className="flex items-center gap-1 text-[9px] px-1 py-0.5">
                  <span className="font-mono text-amber-300 truncate flex-1" title={`${aliased} = ${params[aliased]?.expr ?? '?'}`}>{aliased}</span>
                  <span className="text-slate-500">←</span>
                  <span className="font-mono text-slate-400 truncate flex-1">{orig}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
