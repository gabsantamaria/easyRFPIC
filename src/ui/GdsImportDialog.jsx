// GDS import dialog — layer-mapping table shown after a .gds upload.
//
// One row per (GDS layer, datatype) found in the flattened top cell:
//   [✓ import]  L<layer>/<dt>  <counts>  →  target select
// Targets: <undefined> (imported onto the non-model 'gdsundef' layer —
// visible/snappable on canvas, skipped by every physical export until
// assigned in the Inspector), the stack's waveguide layer, or any
// conductor layer. Unchecked rows are not imported at all.
//
// Mount-on-open (like TwoLineWizard): PhotonicLayout renders this only
// while a parsed upload is pending, so all state initializes fresh per
// file. Pure presentation — parsing/flattening/component building live
// in src/gds/gds-import.js.
import React, { useMemo, useState, useEffect } from 'react';
import { topCellsOf, flattenGDSCell, gdsLayerStats } from '../gds/gds-import.js';

export default function GdsImportDialog({ fileName, parsed, stack, alignCount = 0, onImport, onClose }) {
  // Escape closes — CAPTURE + stopPropagation so the app's global keydown
  // handlers (Esc = clear selection, Delete = delete components!) can't
  // fire behind the modal (same pattern as SettingsPanel/ModalDialog).
  useEffect(() => {
    const onKey = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); onClose?.(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const conductors = useMemo(() => (stack || []).filter(l => l.role === 'conductor'), [stack]);
  const hasWgLayer = useMemo(() => (stack || []).some(l => l.role === 'waveguide'), [stack]);
  const topCells = useMemo(() => {
    const tops = topCellsOf(parsed);
    return tops.length > 0 ? tops : Object.keys(parsed.cells);
  }, [parsed]);
  const [cellName, setCellName] = useState(topCells[0] || '');
  const flat = useMemo(() => flattenGDSCell(parsed, cellName), [parsed, cellName]);
  const stats = useMemo(() => gdsLayerStats(flat.shapes), [flat]);

  // Mapping rows keyed by `${layer}/${datatype}` — re-seeded when the
  // cell (and thus the stats list) changes. Default: import everything
  // as <undefined>; the user maps what they know.
  const [rowsByCell, setRowsByCell] = useState({});
  const rows = rowsByCell[cellName]
    || Object.fromEntries(stats.map(s => [s.key, { include: true, target: 'undef' }]));
  const setRow = (key, patch) => setRowsByCell(prev => ({
    ...prev,
    [cellName]: { ...rows, [key]: { ...rows[key], ...patch } },
  }));

  const [keepCoords, setKeepCoords] = useState(false);

  const totalIncluded = stats.filter(s => rows[s.key]?.include !== false);
  const totalShapes = totalIncluded.reduce((a, s) => a + s.shapes, 0);
  const totalVerts = totalIncluded.reduce((a, s) => a + s.vertices, 0);
  const warnings = [...(parsed.warnings || []), ...(flat.warnings || [])];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(2,6,23,0.7)' }}
      // mousedown-target guard (NOT onClick): a drag that starts inside
      // the panel (text select, checkbox slip) and releases over the
      // backdrop fires click on the backdrop and would silently discard
      // the whole mapping table — same drag-slip-safe pattern as the
      // other wizards.
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="rounded-lg border border-slate-700 shadow-2xl w-[34rem] max-w-[94vw] max-h-[85vh] flex flex-col"
        style={{ background: '#0f172a' }}
      >
        <div className="px-4 py-2 border-b border-slate-700 flex items-center justify-between">
          <h3 className="text-sm font-medium text-slate-200">Import GDS — map layers</h3>
          <span className="text-[10px] text-slate-500 font-mono truncate max-w-[16rem]" title={fileName}>{fileName}</span>
        </div>

        <div className="px-4 py-3 overflow-y-auto flex-1 space-y-3">
          {topCells.length > 1 && (
            <div className="flex items-center gap-2">
              <label className="text-[10px] uppercase tracking-wider text-slate-500 shrink-0">top cell</label>
              <select
                value={cellName}
                onChange={(e) => setCellName(e.target.value)}
                className="flex-1 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-slate-100 outline-none focus:border-cyan-400"
              >
                {topCells.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          )}

          <p className="text-[10px] text-slate-500 leading-snug">
            Each GDS shape becomes an independent canvas shape (polygon → polyshape,
            path → polyline) with its own snap anchors. <span className="text-slate-400">&lt;undefined&gt;</span> imports
            the shapes but keeps them OFF every physical export (HFSS included) until you
            assign a layer in the Inspector. Unchecked rows are ignored entirely.
          </p>

          <table className="w-full text-xs">
            <thead>
              <tr className="text-[9px] uppercase tracking-wider text-slate-500 text-left">
                <th className="pb-1 w-8"></th>
                <th className="pb-1">GDS layer</th>
                <th className="pb-1 text-right pr-3">shapes</th>
                <th className="pb-1">import as</th>
              </tr>
            </thead>
            <tbody>
              {stats.map(s => {
                const row = rows[s.key] || { include: true, target: 'undef' };
                return (
                  <tr key={s.key} className={`border-t border-slate-800 ${row.include === false ? 'opacity-40' : ''}`}>
                    <td className="py-1">
                      <input
                        type="checkbox"
                        checked={row.include !== false}
                        onChange={(e) => setRow(s.key, { include: e.target.checked })}
                        title={row.include !== false ? 'Uncheck to ignore this GDS layer' : 'Checked = import this GDS layer'}
                      />
                    </td>
                    <td className="py-1 font-mono text-slate-200">L{s.layer}/{s.datatype}</td>
                    <td className="py-1 text-right pr-3 text-slate-400 font-mono">
                      {s.shapes}{s.paths > 0 ? ` (${s.paths} path)` : ''}
                    </td>
                    <td className="py-1">
                      <select
                        value={row.target}
                        onChange={(e) => setRow(s.key, { target: e.target.value })}
                        disabled={row.include === false}
                        className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] font-mono text-slate-100 outline-none focus:border-cyan-400 disabled:opacity-50"
                      >
                        <option value="undef">&lt;undefined&gt;</option>
                        {hasWgLayer && <option value="wg">waveguide</option>}
                        {conductors.map(l => (
                          <option key={l.id} value={`cond:${l.id}`}>{l.name || l.id} (conductor)</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
              {stats.length === 0 && (
                <tr><td colSpan={4} className="py-2 text-slate-500 italic">No shapes in this cell.</td></tr>
              )}
            </tbody>
          </table>

          {alignCount > 0 ? (
            <p className="text-[10px] text-cyan-300 leading-snug">
              {alignCount} shape{alignCount === 1 ? '' : 's'} from this file {alignCount === 1 ? 'is' : 'are'} already
              in the scene — this import will ALIGN to them so all original GDS
              distances are preserved (drop point ignored).
            </p>
          ) : (
            <label className="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer">
              <input type="checkbox" checked={keepCoords} onChange={(e) => setKeepCoords(e.target.checked)} />
              Keep original GDS coordinates (otherwise the import is centered at the drop point)
            </label>
          )}

          {totalVerts > 50000 && (
            <p className="text-[10px] text-amber-400 leading-snug">
              Large import: {totalShapes} shapes / {totalVerts.toLocaleString()} vertices — the canvas
              and solver may get slow. Consider unchecking layers you don't need.
            </p>
          )}
          {warnings.map((w, i) => (
            <p key={i} className="text-[10px] text-amber-400/80 leading-snug">⚠ {w.msg}</p>
          ))}
        </div>

        <div className="px-4 py-3 border-t border-slate-700 flex items-center justify-between gap-2">
          <span className="text-[10px] text-slate-500">
            {totalShapes} shape{totalShapes === 1 ? '' : 's'} will import
          </span>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1 rounded text-xs border border-slate-600 text-slate-300 hover:bg-slate-800">
              Cancel
            </button>
            <button
              onClick={() => onImport({ shapes: flat.shapes, mapping: rows, keepCoords, cellName })}
              disabled={totalShapes === 0}
              className="px-3 py-1 rounded text-xs font-medium disabled:opacity-40"
              style={{ background: '#06b6d4', color: '#0f172a' }}
            >
              Import {totalShapes > 0 ? totalShapes : ''}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
