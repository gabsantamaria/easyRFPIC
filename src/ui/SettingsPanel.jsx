import React, { useEffect, useRef, useState } from 'react';
import { X, Download, Upload, RotateCcw, Check } from 'lucide-react';
import { THEMES, THEME_ORDER } from './theme.js';

// Settings & appearance modal. Presentation only — all state lives in the
// parent (PhotonicLayout) `settings` object; this panel reads it and reports
// changes via `onChange(key, value)`. Export/import/restore are delegated to
// the parent so they share the app's download + confirm-dialog helpers.
//
// Props:
//   open       — render the modal when true
//   settings   — the live settings object
//   onChange   — (key, value) => void; updates one setting (persists upstream)
//   onClose    — close the modal
//   onExport   — () => void; serialize + download settings JSON
//   onImport   — (parsedJson) => void; merge an imported settings object
//   onRestore  — () => void; restore defaults (parent confirms first)
export function SettingsPanel({ open, settings, onChange, onClose, onExport, onImport, onRestore }) {
  const fileRef = useRef(null);
  const [importError, setImportError] = useState('');

  // Close on Escape while open.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  // Clear any stale import error each time the panel opens.
  useEffect(() => { if (open) setImportError(''); }, [open]);

  if (!open) return null;

  const pickFile = () => { setImportError(''); fileRef.current?.click(); };
  const onFileChosen = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // allow re-importing the same file
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      onImport(parsed);
      setImportError('');
    } catch (err) {
      setImportError('Could not read that file — expected a settings JSON.');
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center"
      style={{ background: 'rgba(2,6,23,0.7)' }}
      onClick={onClose}
    >
      <div
        className="rounded-lg shadow-2xl border border-slate-700 w-[34rem] max-w-[92vw] max-h-[88vh] overflow-hidden flex flex-col"
        style={{ background: 'var(--app-slate-900)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-2.5 border-b border-slate-700 flex items-center justify-between" style={{ background: 'var(--app-slate-950)' }}>
          <h2 className="text-sm font-semibold text-slate-100">Settings &amp; appearance</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200" aria-label="Close settings">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="px-4 py-3 overflow-y-auto flex flex-col gap-5">
          {/* Appearance */}
          <section>
            <SectionLabel>Appearance</SectionLabel>
            <p className="text-[11px] text-slate-500 mb-2">Theme recolors the whole UI and the canvas. Applied live.</p>
            <div className="grid grid-cols-4 gap-2">
              {THEME_ORDER.map((id) => (
                <ThemeSwatch
                  key={id}
                  theme={THEMES[id]}
                  active={settings.theme === id}
                  onClick={() => onChange('theme', id)}
                />
              ))}
            </div>
          </section>

          {/* Canvas */}
          <section>
            <SectionLabel>Canvas</SectionLabel>
            <div className="flex flex-col divide-y divide-slate-800 rounded border border-slate-700 overflow-hidden">
              <ToggleRow
                label="Show dimensions on select"
                hint="Show editable width/height arrows on the selected rectangle (and snap offsets)."
                checked={settings.showDimensionsOnSelect}
                onChange={(v) => onChange('showDimensionsOnSelect', v)}
              />
              <ToggleRow
                label="Dimension overlay (all parts)"
                hint="Draw read-only dimension arrows over every parameter-bound width, height, and snap offset."
                checked={settings.showDimensionsOverlay}
                onChange={(v) => onChange('showDimensionsOverlay', v)}
              />
              <ToggleRow
                label="Show background grid"
                hint="Draw the background grid (snap behavior is independent)."
                checked={settings.gridVisible}
                onChange={(v) => onChange('gridVisible', v)}
              />
              <ToggleRow
                label="Snap to grid"
                hint="Snap drags to the grid (hold Cmd/Ctrl while dragging to disable temporarily)."
                checked={settings.gridSnap}
                onChange={(v) => onChange('gridSnap', v)}
              />
              <div className="flex items-center justify-between px-3 py-2">
                <div className="min-w-0">
                  <div className="text-xs text-slate-200">Grid size</div>
                  <div className="text-[11px] text-slate-500">Grid pitch in microns.</div>
                </div>
                <div className="flex items-center gap-1">
                  <input
                    type="number" step="0.1" min="0.1"
                    value={settings.gridSize}
                    onChange={(e) => {
                      const n = parseFloat(e.target.value);
                      if (Number.isFinite(n) && n > 0) onChange('gridSize', Math.max(0.1, n));
                    }}
                    className="w-16 bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-xs text-slate-100 outline-none focus:border-cyan-500"
                  />
                  <span className="text-[11px] text-slate-500">µm</span>
                </div>
              </div>
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 border-t border-slate-700 flex items-center justify-between gap-2" style={{ background: 'var(--app-slate-950)' }}>
          <button
            onClick={() => { setImportError(''); onRestore(); }}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs border border-slate-600 text-slate-300 hover:bg-slate-800 hover:text-red-300 hover:border-red-700"
            title="Reset every setting (including theme) to its default"
          >
            <RotateCcw size={12} /> Restore defaults
          </button>
          <div className="flex items-center gap-2">
            {importError && <span className="text-[11px] text-red-400 max-w-[12rem] truncate" title={importError}>{importError}</span>}
            <button
              onClick={pickFile}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs border border-slate-600 text-slate-300 hover:bg-slate-800"
              title="Import settings from a JSON file. Only the settings present in the file are applied; the rest are left unchanged."
            >
              <Upload size={12} /> Import
            </button>
            <button
              onClick={onExport}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs border border-slate-600 text-slate-300 hover:bg-slate-800"
              title="Export all settings (including the selected theme) to a JSON file."
            >
              <Download size={12} /> Export
            </button>
          </div>
        </div>
        <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={onFileChosen} />
      </div>
    </div>
  );
}

function SectionLabel({ children }) {
  return <div className="text-[11px] uppercase tracking-wide font-semibold text-slate-400 mb-1.5">{children}</div>;
}

function ToggleRow({ label, hint, checked, onChange }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex items-center justify-between px-3 py-2 text-left hover:bg-slate-800/60"
    >
      <div className="min-w-0 mr-3">
        <div className="text-xs text-slate-200">{label}</div>
        {hint && <div className="text-[11px] text-slate-500">{hint}</div>}
      </div>
      <span
        className={`relative inline-flex shrink-0 h-4 w-7 rounded-full transition-colors ${checked ? 'bg-cyan-600' : 'bg-slate-600'}`}
        aria-checked={checked}
        role="switch"
      >
        <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-slate-100 transition-all ${checked ? 'left-3.5' : 'left-0.5'}`} />
      </span>
    </button>
  );
}

// Mini canvas-preview card for a theme: a small SVG showing the theme's canvas
// background, grid, and axis, plus a chrome strip, with a name below.
function ThemeSwatch({ theme, active, onClick }) {
  const c = theme.canvas;
  const s = theme.swatch || {};
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col items-stretch rounded-md overflow-hidden border transition-all ${active ? 'border-cyan-400 ring-2 ring-cyan-500/40' : 'border-slate-700 hover:border-slate-500'}`}
      title={theme.description}
    >
      <div className="relative">
        <svg viewBox="0 0 64 40" className="w-full block" preserveAspectRatio="none" style={{ height: 38 }}>
          {/* chrome strip */}
          <rect x="0" y="0" width="64" height="8" fill={s.chrome || '#0f172a'} />
          <rect x="3" y="3" width="14" height="2" rx="1" fill={s.accent || '#06b6d4'} />
          {/* canvas */}
          <rect x="0" y="8" width="64" height="32" fill={c.canvasBg} />
          {/* grid */}
          <g stroke={c.gridFine} strokeWidth="0.5">
            <line x1="16" y1="8" x2="16" y2="40" /><line x1="32" y1="8" x2="32" y2="40" /><line x1="48" y1="8" x2="48" y2="40" />
            <line x1="0" y1="20" x2="64" y2="20" /><line x1="0" y1="30" x2="64" y2="30" />
          </g>
          <line x1="0" y1="24" x2="64" y2="24" stroke={c.gridMajor} strokeWidth="0.7" />
          {/* a sample part + axis */}
          <line x1="24" y1="8" x2="24" y2="40" stroke={c.axis} strokeWidth="0.7" />
          <rect x="28" y="18" width="16" height="10" rx="1.5" fill={s.accent || '#06b6d4'} opacity="0.85" />
        </svg>
        {active && (
          <span className="absolute top-0.5 right-0.5 bg-cyan-500 text-white rounded-full p-0.5">
            <Check size={9} strokeWidth={3} />
          </span>
        )}
      </div>
      <div className={`text-[10px] text-center py-1 ${active ? 'text-cyan-300 font-semibold' : 'text-slate-400'}`} style={{ background: 'var(--app-slate-800)' }}>
        {theme.name}
      </div>
    </button>
  );
}

export default SettingsPanel;
