// HelpTutorial — an animated walkthrough of the app's main capabilities.
//
// Opened from the "?" button in the header. Each step renders a mini
// version of the actual app frame (real Tailwind classes, real
// lucide-react icons, real button colors) so the user immediately
// recognizes what they're looking at, with CSS keyframe animations
// pointing at the relevant control / panel / canvas action.
//
// Stepping forward re-mounts the demo component so animations restart
// from frame 0. Esc / ←→ + dot navigation + Prev/Next.
import React, { useEffect, useState } from 'react';
import {
  Plus, Trash2, Save, FileText, FilePlus, FolderTree, BookOpen,
  Ruler, Download, Settings2, Layers, Square, Link2, FlipHorizontal,
  Radio, Box, Combine, Minus, X as XIcon, Circle,
  Maximize2, AlertTriangle, Grid3x3,
} from 'lucide-react';

// ── Shared mini-app frame ────────────────────────────────────────────
// Reusable shell that mimics the app's two-row header + tab strip + main
// area layout. Children render into the main area. Header content is
// configurable per step so we can highlight different chrome elements.
function MiniHeader({ children, accent }) {
  return (
    <div
      className="flex items-center gap-2 px-2 py-1.5 border-b border-slate-700"
      style={{ background: '#020617' }}
    >
      {/* App logo (same glyph as the live header, just smaller) */}
      <svg viewBox="0 0 64 64" width="18" height="18" aria-hidden="true" className="flex-shrink-0">
        <rect x="2" y="2" width="60" height="60" rx="10" ry="10" fill="#0f172a" stroke="#334155" strokeWidth="1.5"/>
        <path d="M 8 22 H 56" stroke="#daa520" strokeWidth="3" fill="none" strokeLinecap="round"/>
        <g stroke="#daa520" strokeWidth="2" fill="none" strokeLinejoin="round">
          <rect x="11" y="10" width="7" height="9"/><rect x="22" y="10" width="7" height="9"/>
          <rect x="33" y="10" width="7" height="9"/><rect x="44" y="10" width="7" height="9"/>
        </g>
        <path d="M 8 42 H 56" stroke="#daa520" strokeWidth="3" fill="none" strokeLinecap="round"/>
        <g stroke="#daa520" strokeWidth="2" fill="none" strokeLinejoin="round">
          <rect x="11" y="45" width="7" height="9"/><rect x="22" y="45" width="7" height="9"/>
          <rect x="33" y="45" width="7" height="9"/><rect x="44" y="45" width="7" height="9"/>
        </g>
        <path d="M 0 32 H 64" stroke="#10b981" strokeWidth="4" fill="none" strokeLinecap="round"/>
        <path d="M 0 32 H 64" stroke="#34d399" strokeWidth="1.5" fill="none" strokeLinecap="round" opacity="0.8"/>
      </svg>
      <span
        className="text-[10px] font-bold tracking-tight flex-shrink-0"
        style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}
      >
        <span className="text-slate-100">MPL</span>{' '}
        <span className="text-emerald-400">easy</span>
        <span className="text-amber-500">RF</span>
        <span className="text-cyan-300">PIC</span>
      </span>
      <div className="flex-1 flex items-center gap-1 ml-2">{children}</div>
      {accent && <span className={`text-[9px] font-medium ${accent.color || 'text-cyan-400'}`}>{accent.label}</span>}
    </div>
  );
}

// Mini tab-strip mirror of the real PARAMS/LAYERS/SHAPES/… row.
function MiniTabStrip({ active }) {
  const tabs = [
    { id: 'params',   label: 'PARAMS',   icon: Settings2 },
    { id: 'layers',   label: 'LAYERS',   icon: Layers },
    { id: 'shapes',   label: 'SHAPES',   icon: Square },
    { id: 'snaps',    label: 'SNAPS',    icon: Link2 },
    { id: 'mirrors',  label: 'MIRRORS',  icon: FlipHorizontal },
    { id: 'library',  label: 'LIBRARY',  icon: BookOpen },
    { id: 'setup',    label: 'SETUP',    icon: Radio },
    { id: 'code',     label: 'CODE',     icon: Box },
  ];
  return (
    <div className="flex border-b border-slate-700 text-[7px]" style={{ background: '#0f172a' }}>
      {tabs.map(t => {
        const Icon = t.icon;
        const isActive = active === t.id;
        return (
          <div
            key={t.id}
            className={`flex-1 px-0.5 py-1 flex flex-col items-center gap-0.5 tracking-wider font-medium ${
              isActive ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-slate-400'
            }`}
          >
            <Icon size={9} />
            {t.label}
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// STEP 1 — Layer stack
// Real LAYERS panel on the left with layer cards sliding in; right area
// has a Z-axis cross-section assembling the stack bottom-up.
// ─────────────────────────────────────────────────────────────────────
function StackDemo() {
  return (
    <div className="w-full h-full flex flex-col rounded overflow-hidden" style={{ background: '#0f172a' }}>
      <MiniHeader accent={{ label: 'LAYERS panel', color: 'text-cyan-400' }} />
      <div className="flex-1 flex min-h-0">
        {/* Left panel — LAYERS tab active */}
        <div className="w-44 border-r border-slate-700 flex flex-col" style={{ background: '#0f172a' }}>
          <MiniTabStrip active="layers" />
          <div className="p-1.5 space-y-1 flex-1 overflow-hidden">
            {/* Layer cards mirror LayerCard.jsx styling */}
            <div className="tut-layer-card-1 rounded border border-slate-700 px-1.5 py-1 flex items-center gap-1" style={{ background: '#1e293b' }}>
              <div className="w-2.5 h-2.5 rounded-sm" style={{ background: '#cbd5e1' }} />
              <span className="text-[8px] text-slate-200 font-mono flex-1 truncate">Cladding</span>
              <span className="text-[7px] text-slate-500 font-mono">h_wg</span>
            </div>
            <div className="tut-layer-card-2 rounded border border-slate-700 px-1.5 py-1 flex items-center gap-1" style={{ background: '#1e293b' }}>
              <div className="w-2.5 h-2.5 rounded-sm" style={{ background: '#daa520' }} />
              <span className="text-[8px] text-amber-200 font-mono flex-1 truncate">Conductor</span>
              <span className="text-[7px] text-slate-500 font-mono">h_cond</span>
            </div>
            <div className="tut-layer-card-3 rounded border border-slate-700 px-1.5 py-1 flex items-center gap-1" style={{ background: '#1e293b' }}>
              <div className="w-2.5 h-2.5 rounded-sm" style={{ background: '#86efac' }} />
              <span className="text-[8px] text-emerald-200 font-mono flex-1 truncate">LiTaO₃ WG</span>
              <span className="text-[7px] text-slate-500 font-mono">h_wg</span>
            </div>
            <div className="tut-layer-card-4 rounded border border-slate-700 px-1.5 py-1 flex items-center gap-1" style={{ background: '#1e293b' }}>
              <div className="w-2.5 h-2.5 rounded-sm" style={{ background: '#8da0c0' }} />
              <span className="text-[8px] text-slate-200 font-mono flex-1 truncate">Buried oxide</span>
              <span className="text-[7px] text-slate-500 font-mono">h_sio2</span>
            </div>
            <div className="tut-layer-card-5 rounded border border-slate-700 px-1.5 py-1 flex items-center gap-1" style={{ background: '#1e293b' }}>
              <div className="w-2.5 h-2.5 rounded-sm" style={{ background: '#5a6878' }} />
              <span className="text-[8px] text-slate-300 font-mono flex-1 truncate">Si handle</span>
              <span className="text-[7px] text-slate-500 font-mono">h_si</span>
            </div>
          </div>
        </div>
        {/* Canvas: Z-axis cross-section */}
        <div className="flex-1 relative" style={{ background: '#020617' }}>
          <svg viewBox="0 0 220 220" className="w-full h-full" preserveAspectRatio="xMidYMid meet">
            {/* Substrate — Si handle */}
            <g className="tut-stack-bottom">
              <rect x="20" y="170" width="180" height="32" fill="#5a6878" stroke="#64748b" />
              <text x="110" y="190" fontSize="8" textAnchor="middle" fill="#cbd5e1" fontFamily="monospace">Si handle</text>
            </g>
            {/* BOX (SiO2) */}
            <g className="tut-stack-box">
              <rect x="20" y="148" width="180" height="22" fill="#8da0c0" stroke="#a0aec0" />
              <text x="110" y="163" fontSize="7" textAnchor="middle" fill="#1e293b" fontFamily="monospace">BOX (SiO₂)</text>
            </g>
            {/* WG layer (LiTaO3 rib + slab) */}
            <g className="tut-stack-wg">
              <rect x="20" y="138" width="180" height="10" fill="#86efac" fillOpacity="0.4" stroke="#10b981" strokeOpacity="0.5" />
              <polygon points="100,128 120,128 124,138 96,138" fill="#86efac" stroke="#10b981" />
              <text x="110" y="125" fontSize="7" textAnchor="middle" fill="#34d399" fontFamily="monospace">LiTaO₃ WG (rib)</text>
            </g>
            {/* Conductor: two metal pads */}
            <g className="tut-stack-cond">
              <rect x="40" y="120" width="40" height="8" fill="#daa520" stroke="#fbbf24" />
              <rect x="140" y="120" width="40" height="8" fill="#daa520" stroke="#fbbf24" />
              <text x="110" y="117" fontSize="7" textAnchor="middle" fill="#fbbf24" fontFamily="monospace">Conductor</text>
            </g>
            {/* Cladding wrapping conductors + wg */}
            <g className="tut-stack-clad">
              <rect x="20" y="106" width="180" height="32" fill="#cbd5e1" fillOpacity="0.18" stroke="#94a3b8" strokeDasharray="2,1.5" />
              <text x="110" y="100" fontSize="7" textAnchor="middle" fill="#94a3b8" fontFamily="monospace">Cladding (SiO₂)</text>
            </g>
            {/* Z axis label */}
            <line x1="10" y1="200" x2="10" y2="100" stroke="#475569" strokeWidth="0.8" markerEnd="url(#tut-z-arrow)" />
            <text x="6" y="92" fontSize="7" fill="#94a3b8" fontFamily="monospace">Z</text>
            <defs>
              <marker id="tut-z-arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto">
                <path d="M 0 2 L 10 5 L 0 8 Z" fill="#475569" />
              </marker>
            </defs>
          </svg>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// STEP 2 — Drawing & layer selection
// Real header layer-dropdown (cycles colors) + shape button row, with
// the canvas drawing a rect of the matching color underneath.
// ─────────────────────────────────────────────────────────────────────
function DrawingDemo() {
  // The shape-button row sits on the right of header row 1 in the real
  // app. We render a compact strip below the brand so it fits.
  return (
    <div className="w-full h-full flex flex-col rounded overflow-hidden" style={{ background: '#0f172a' }}>
      <MiniHeader>
        {/* The layer dropdown — cycles between waveguide / electrode / port.
            Three stacked absolutely-positioned spans, opacity-cycled in
            lockstep with the pill background-color animation, so the
            label text changes alongside the pill color. */}
        <div className="tut-layer-pill flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium relative">
          <span className="relative inline-block" style={{ width: 64, height: 14 }}>
            <span className="tut-label-wg absolute inset-0 flex items-center" style={{ color: '#1f1300' }}>Waveguide</span>
            <span className="tut-label-cond absolute inset-0 flex items-center" style={{ color: '#1f1300' }}>Conductor</span>
            <span className="tut-label-port absolute inset-0 flex items-center" style={{ color: '#fee2e2' }}>Port</span>
          </span>
          <span className="text-[8px] opacity-70">▾</span>
        </div>
        {/* Shape buttons (real lucide icons in 7×7 squares) */}
        <button className="tut-shape-rect flex items-center justify-center w-6 h-6 rounded" style={{ background: '#1e293b', color: '#e2e8f0' }}>
          <Square size={12} />
        </button>
        <button className="flex items-center justify-center w-6 h-6 rounded" style={{ background: '#1e293b', color: '#e2e8f0' }}>
          <Circle size={12} />
        </button>
        <button className="flex items-center justify-center w-6 h-6 rounded" style={{ background: '#1e293b', color: '#e2e8f0' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="12" cy="12" rx="10" ry="6"/></svg>
        </button>
      </MiniHeader>
      {/* Mini canvas — cursor draws a rect of the layer's color */}
      <div className="flex-1 relative" style={{ background: '#020617' }}>
        <svg viewBox="0 0 400 200" className="w-full h-full" preserveAspectRatio="xMidYMid meet">
          {/* Drawn rectangles cycle by layer */}
          <rect className="tut-draw-rect-wg" x="60" y="50" width="0" height="30" fill="#10b981" fillOpacity="0.45" stroke="#34d399" strokeWidth="1.5" />
          <rect className="tut-draw-rect-cond" x="60" y="95" width="0" height="22" fill="#daa520" fillOpacity="0.65" stroke="#fbbf24" strokeWidth="1.5" />
          <rect className="tut-draw-rect-port" x="60" y="135" width="0" height="22" fill="#b91c1c" fillOpacity="0.55" stroke="#ef4444" strokeWidth="1.5" />
          {/* Cursor follows the drag */}
          <g className="tut-cursor-draw">
            <path d="M 0 0 L 0 16 L 4.5 11.5 L 8 18 L 10.5 17 L 7 11 L 13 11 Z" fill="#fff" stroke="#0f172a" strokeWidth="0.5" />
          </g>
        </svg>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// STEP 3 — Parameters & scroll wheel
// Real PARAMS panel row + ParamTuner (the ±20 % buttons). Scroll wheel
// hint animates over the value; a live waveguide preview resizes.
// ─────────────────────────────────────────────────────────────────────
function ParamsDemo() {
  return (
    <div className="w-full h-full flex flex-col rounded overflow-hidden" style={{ background: '#0f172a' }}>
      <MiniHeader accent={{ label: 'PARAMS panel', color: 'text-cyan-400' }} />
      <div className="flex-1 flex min-h-0">
        <div className="w-56 border-r border-slate-700 flex flex-col" style={{ background: '#0f172a' }}>
          <MiniTabStrip active="params" />
          <div className="p-1.5 space-y-1">
            {/* + add / cleanup row (real buttons) */}
            <div className="flex gap-1 mb-1">
              <div className="flex-1 flex items-center justify-center gap-1 px-1.5 py-0.5 rounded border border-dashed border-slate-600 text-[8px] text-slate-300">
                <Plus size={8} /> add
              </div>
              <div className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-slate-600 text-[8px] text-slate-400">
                <Trash2 size={8} /> cleanup
              </div>
            </div>
            {/* The animated parameter row — real ParamRow styling */}
            <div className="rounded border border-cyan-500/70 ring-1 ring-cyan-500/30" style={{ background: 'rgba(14,116,144,0.18)' }}>
              <div className="flex items-center gap-1 px-1.5 py-1">
                <span className="text-[10px] font-mono font-bold text-cyan-300 w-12 min-w-0">w_wg</span>
                <div className="flex-1 min-w-0 relative">
                  <div className="w-full bg-slate-900 border border-slate-700 rounded text-[10px] font-mono text-white px-1 py-0.5 leading-tight">
                    <span className="tut-param-expr">1.2</span>
                  </div>
                  {/* Scroll-wheel hint, positioned over the value */}
                  <div className="tut-scroll-hint absolute right-1 top-1/2 -translate-y-1/2 pointer-events-none">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#94a3b8" strokeWidth="1.5">
                      <rect x="8" y="3" width="8" height="18" rx="4" />
                      <line x1="12" y1="7" x2="12" y2="11" />
                    </svg>
                  </div>
                </div>
                <span className="text-[8px] text-slate-500 font-mono w-8 text-right truncate">
                  <span className="tut-param-eval">1.20</span>µm
                </span>
                <span className="text-slate-500 text-[8px]">…</span>
                <Trash2 size={8} className="text-slate-600" />
              </div>
              {/* ParamTuner ±20 % strip */}
              <div className="flex gap-px px-1.5 pb-1">
                <div className="flex-1 text-center text-[7px] py-0.5 rounded bg-slate-800 text-slate-400">−20%</div>
                <div className="flex-1 text-center text-[7px] py-0.5 rounded bg-slate-800 text-slate-400">−10%</div>
                <div className="flex-1 text-center text-[7px] py-0.5 rounded bg-slate-800 text-slate-400">+10%</div>
                <div className="flex-1 text-center text-[7px] py-0.5 rounded bg-slate-800 text-slate-400">+20%</div>
              </div>
            </div>
            {/* Other un-involved rows for context */}
            <div className="rounded border border-slate-700 px-1.5 py-1 flex items-center gap-1" style={{ background: '#1e293b' }}>
              <span className="text-[10px] font-mono font-bold text-cyan-300 w-12">h_wg</span>
              <span className="text-[10px] font-mono text-slate-400 flex-1">0.6</span>
              <span className="text-[8px] text-slate-500">0.60µm</span>
            </div>
            <div className="rounded border border-slate-700 px-1.5 py-1 flex items-center gap-1" style={{ background: '#1e293b' }}>
              <span className="text-[10px] font-mono font-bold text-cyan-300 w-12">cap_d</span>
              <span className="text-[10px] font-mono text-slate-400 flex-1">2*R + 5</span>
              <span className="text-[8px] text-slate-500">205µm</span>
            </div>
          </div>
        </div>
        {/* Canvas: live waveguide preview that resizes with w_wg */}
        <div className="flex-1 relative flex flex-col" style={{ background: '#020617' }}>
          <div className="absolute inset-0 flex items-center justify-center">
            <svg viewBox="0 0 200 200" className="w-full h-full" preserveAspectRatio="xMidYMid meet">
              {/* Substrate */}
              <rect x="10" y="120" width="180" height="20" fill="#5a6878" />
              <rect x="10" y="108" width="180" height="12" fill="#8da0c0" fillOpacity="0.7" />
              {/* The waveguide rib — width animates with w_wg */}
              <rect className="tut-live-wg-rib" x="100" y="92" width="0" height="16" fill="#86efac" stroke="#10b981" strokeWidth="1.5" />
              {/* Width dimension arrow */}
              <line className="tut-live-dim" x1="100" y1="86" x2="100" y2="86"
                stroke="#a78bfa" markerStart="url(#tut-d-arr)" markerEnd="url(#tut-d-arr)" />
              <text x="100" y="80" fontSize="7" textAnchor="middle" fill="#c4b5fd" fontFamily="monospace">w_wg</text>
              <defs>
                <marker id="tut-d-arr" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto">
                  <path d="M 0 2 L 10 5 L 0 8 Z" fill="#a78bfa" />
                </marker>
              </defs>
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// STEP 4 — Snapping (option-drag + manual)
// Header with SNAPS tab; canvas shows two shapes; cursor drags one with
// OPT badge; pink anchor markers; commit shows a SnapConnectionRow.
// ─────────────────────────────────────────────────────────────────────
function SnapDemo() {
  return (
    <div className="w-full h-full flex flex-col rounded overflow-hidden" style={{ background: '#0f172a' }}>
      <MiniHeader accent={{ label: 'SNAPS panel', color: 'text-cyan-400' }} />
      <div className="flex-1 flex min-h-0">
        <div className="w-48 border-r border-slate-700 flex flex-col" style={{ background: '#0f172a' }}>
          <MiniTabStrip active="snaps" />
          <div className="p-1.5 space-y-1">
            <div className="text-[8px] text-slate-500 px-1 mb-0.5 uppercase tracking-wider">Active snaps</div>
            {/* SnapConnectionRow mirror — appears after the drag */}
            <div className="tut-snap-row rounded border border-slate-700 px-1.5 py-1" style={{ background: '#1e293b' }}>
              <div className="flex items-center gap-1 text-[8px] font-mono">
                <span className="text-cyan-300">capA</span>
                <span className="text-slate-500">.W</span>
                <span className="text-pink-400 mx-0.5">→</span>
                <span className="text-amber-300">wg1</span>
                <span className="text-slate-500">.E</span>
              </div>
              <div className="flex items-center gap-1 text-[7px] font-mono mt-0.5">
                <span className="text-slate-500">dx</span>
                <span className="text-slate-200 flex-1">2</span>
                <span className="text-slate-500">dy</span>
                <span className="text-slate-200 flex-1">0</span>
              </div>
            </div>
          </div>
        </div>
        {/* Canvas with the drag animation */}
        <div className="flex-1 relative" style={{ background: '#020617' }}>
          <svg viewBox="0 0 360 200" className="w-full h-full" preserveAspectRatio="xMidYMid meet">
            {/* OPT key badge in top-left */}
            <g className="tut-opt-badge">
              <rect x="14" y="14" width="44" height="20" rx="3" fill="#1e293b" stroke="#ec4899" strokeWidth="1" />
              <text x="36" y="27" fontSize="10" textAnchor="middle" fill="#f9a8d4" fontFamily="monospace" fontWeight="bold">⌥ OPT</text>
            </g>
            {/* Target shape (right) — stays put */}
            <g transform="translate(260, 100)">
              <rect x="-32" y="-22" width="64" height="44" fill="#86efac" fillOpacity="0.35" stroke="#10b981" strokeWidth="1.5" />
              <text x="0" y="3" fontSize="9" textAnchor="middle" fill="#34d399" fontFamily="monospace">wg1</text>
              {/* Pink anchor on left edge */}
              <circle className="tut-snap-anchor-target" cx="-32" cy="0" r="4" fill="#ec4899" />
            </g>
            {/* Movable shape (left) — drags right and snaps */}
            <g className="tut-snap-mover">
              <rect x="-30" y="-20" width="60" height="40" fill="#daa520" fillOpacity="0.65" stroke="#fbbf24" strokeWidth="1.5" />
              <text x="0" y="3" fontSize="9" textAnchor="middle" fill="#3d2c00" fontFamily="monospace" fontWeight="bold">capA</text>
              {/* Pink anchor on right edge */}
              <circle className="tut-snap-anchor-mover" cx="30" cy="0" r="4" fill="#ec4899" />
            </g>
            {/* Dashed snap connection (appears after lock) */}
            <line className="tut-snap-link" x1="0" y1="0" x2="0" y2="0" stroke="#ec4899" strokeWidth="1.5" strokeDasharray="3,2" />
            {/* Cursor */}
            <g className="tut-snap-cursor">
              <path d="M 0 0 L 0 16 L 4.5 11.5 L 8 18 L 10.5 17 L 7 11 L 13 11 Z" fill="#fff" stroke="#0f172a" strokeWidth="0.5" />
            </g>
          </svg>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// STEP 5 — Operations (bool dropdown + repeat transform)
// Real BOOL dropdown (cyan-dark bg, real lucide icons) with menu opening,
// REPEAT button (violet) demonstrating the transform chain.
// ─────────────────────────────────────────────────────────────────────
function OpsDemo() {
  return (
    <div className="w-full h-full flex flex-col rounded overflow-hidden" style={{ background: '#0f172a' }}>
      <MiniHeader>
        {/* BOOL dropdown button (the real cyan-dark bg from row 2) */}
        <div className="tut-bool-btn flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] text-white" style={{ background: '#0e7490' }}>
          <Combine size={10} /> bool
          <span className="text-[8px] opacity-80">▾</span>
        </div>
        {/* MIRROR dropdown (violet) */}
        <div className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] text-white" style={{ background: '#7c3aed' }}>
          <FlipHorizontal size={10} /> mirror
          <span className="text-[8px] opacity-80">▾</span>
        </div>
      </MiniHeader>
      <div className="flex-1 relative" style={{ background: '#020617' }}>
        {/* Dropdown menu — drops from the bool button */}
        <div className="tut-bool-menu absolute top-1 left-2 rounded border border-slate-700 shadow-xl text-[9px] py-1" style={{ background: '#1e293b', minWidth: '140px' }}>
          <div className="px-2 py-1 flex items-center gap-1.5 text-slate-200">
            <Combine size={10} /> <span>Union</span>
          </div>
          <div className="px-2 py-1 flex items-center gap-1.5 text-slate-200">
            <XIcon size={10} /> <span>Intersect</span>
          </div>
          <div className="tut-bool-subtract px-2 py-1 flex items-center gap-1.5 text-slate-200 rounded mx-1">
            <Minus size={10} /> <span>Subtract</span>
          </div>
          <div className="px-2 py-1 flex items-center gap-1.5 text-slate-200">
            <Minus size={10} /> <span>Punch</span>
          </div>
        </div>
        {/* Canvas: subtract result + repeat array */}
        <svg viewBox="0 0 400 200" className="w-full h-full" preserveAspectRatio="xMidYMid meet">
          {/* LEFT half: subtract demo */}
          <text x="80" y="40" fontSize="9" textAnchor="middle" fill="#67e8f9" fontFamily="monospace" fontWeight="bold">SUBTRACT</text>
          <defs>
            <mask id="tut-sub-mask">
              <rect x="40" y="60" width="120" height="80" fill="white" />
              <circle className="tut-ops-sub-tool" cx="100" cy="100" r="0" fill="black" />
            </mask>
          </defs>
          <g mask="url(#tut-sub-mask)">
            <rect className="tut-ops-sub-base" x="55" y="70" width="60" height="60" fill="#daa520" fillOpacity="0.65" stroke="#fbbf24" strokeWidth="1.5" />
          </g>
          {/* The tool shape (visible during the merge animation, then fades) */}
          <circle className="tut-ops-sub-tool-outline" cx="100" cy="100" r="0" fill="none" stroke="#ec4899" strokeWidth="1" strokeDasharray="2,1.5" />

          {/* Divider */}
          <line x1="200" y1="50" x2="200" y2="170" stroke="#334155" strokeDasharray="2,2" />

          {/* RIGHT half: repeat transform */}
          <text x="300" y="40" fontSize="9" textAnchor="middle" fill="#67e8f9" fontFamily="monospace" fontWeight="bold">REPEAT</text>
          <rect className="tut-ops-rep-1" x="220" y="80" width="28" height="44" fill="#daa520" fillOpacity="0.7" stroke="#fbbf24" strokeWidth="1.5" />
          <rect className="tut-ops-rep-2" x="260" y="80" width="28" height="44" fill="#daa520" fillOpacity="0.5" stroke="#fbbf24" strokeWidth="1.5" opacity="0" />
          <rect className="tut-ops-rep-3" x="300" y="80" width="28" height="44" fill="#daa520" fillOpacity="0.5" stroke="#fbbf24" strokeWidth="1.5" opacity="0" />
          <rect className="tut-ops-rep-4" x="340" y="80" width="28" height="44" fill="#daa520" fillOpacity="0.5" stroke="#fbbf24" strokeWidth="1.5" opacity="0" />
          {/* TransformChain mini hint */}
          <g className="tut-ops-rep-hint">
            <rect x="220" y="138" width="148" height="14" rx="2" fill="#1e293b" stroke="#475569" />
            <text x="226" y="148" fontSize="7" fill="#94a3b8" fontFamily="monospace">↻ repeat n=3 dx=40</text>
          </g>
        </svg>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// STEP 6 — Saving (workspace → designs → versions)
// Real header row 2 — workspace pill, designs button, save button.
// Designs popout appears with version rows and current "in progress"
// chip mirrors the actual version history UI.
// ─────────────────────────────────────────────────────────────────────
function SaveDemo() {
  return (
    <div className="w-full h-full flex flex-col rounded overflow-hidden" style={{ background: '#0f172a' }}>
      <MiniHeader>
        {/* Pretend right-side cluster: workspace + designs + save */}
        <div className="flex-1" />
        <div className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-cyan-700 text-[9px]" style={{ background: '#164e63', color: '#a5f3fc' }}>
          <FolderTree size={10} />
          <span className="font-mono">default</span>
          <span className="text-[7px] opacity-70">▾</span>
        </div>
        <div className="tut-save-designs-btn flex items-center gap-1 px-1.5 py-0.5 rounded border border-slate-600 text-[9px] text-slate-200">
          <FileText size={10} />
          <span className="font-mono">my_modulator</span>
          <span className="text-[7px] text-emerald-400 ml-0.5">●</span>
        </div>
        <div className="tut-save-btn flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium" style={{ background: '#22c55e', color: '#0f172a' }}>
          <Save size={10} /> save
        </div>
      </MiniHeader>
      {/* Designs popout — mirrors the real flyout */}
      <div className="flex-1 relative" style={{ background: '#020617' }}>
        <div className="tut-designs-popout absolute top-2 right-2 w-56 rounded border border-slate-700 shadow-xl" style={{ background: '#0f172a' }}>
          <div className="px-2 py-1.5 border-b border-slate-700 flex items-center justify-between">
            <span className="text-[9px] text-slate-300 font-medium">SAVED DESIGNS</span>
            <FilePlus size={9} className="text-slate-400" />
          </div>
          {/* Design rows */}
          <div className="px-1.5 py-1 space-y-1">
            <div className="rounded px-1.5 py-1 border border-cyan-500" style={{ background: 'rgba(14,116,144,0.18)' }}>
              <div className="flex items-center gap-1">
                <FileText size={9} className="text-cyan-300" />
                <span className="text-[9px] font-mono text-cyan-200 flex-1">my_modulator</span>
                <span className="text-[7px] text-slate-500">CURRENT</span>
              </div>
              {/* Version rows */}
              <div className="mt-1 pl-3 space-y-0.5">
                <div className="tut-save-v-current flex items-center gap-1 px-1 py-0.5 rounded text-[8px] font-mono" style={{ background: 'rgba(245,158,11,0.15)' }}>
                  <span className="text-amber-300">✏</span>
                  <span className="text-amber-200 flex-1">current (in progress)</span>
                </div>
                <div className="tut-save-v3 flex items-center gap-1 px-1 py-0.5 rounded text-[8px] font-mono text-slate-300">
                  <span className="text-cyan-400">●</span> v3 — tuned cap_d
                </div>
                <div className="tut-save-v2 flex items-center gap-1 px-1 py-0.5 rounded text-[8px] font-mono text-slate-400">
                  <span className="text-slate-500">●</span> v2 — w_wg=0.6
                </div>
                <div className="tut-save-v1 flex items-center gap-1 px-1 py-0.5 rounded text-[8px] font-mono text-slate-400">
                  <span className="text-slate-500">●</span> v1 — initial
                </div>
              </div>
            </div>
            <div className="tut-save-design-2 rounded px-1.5 py-1 border border-slate-700">
              <div className="flex items-center gap-1">
                <FileText size={9} className="text-slate-400" />
                <span className="text-[9px] font-mono text-slate-300">filter_v2</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// STEP 7 — Library
// LIBRARY tab active; "Save selection to library" + an inserted item.
// ─────────────────────────────────────────────────────────────────────
function LibraryDemo() {
  return (
    <div className="w-full h-full flex flex-col rounded overflow-hidden" style={{ background: '#0f172a' }}>
      <MiniHeader accent={{ label: 'LIBRARY panel', color: 'text-cyan-400' }} />
      <div className="flex-1 flex min-h-0">
        <div className="w-52 border-r border-slate-700 flex flex-col" style={{ background: '#0f172a' }}>
          <MiniTabStrip active="library" />
          <div className="p-1.5 space-y-1">
            <div className="text-[8px] text-slate-500 uppercase tracking-wider mb-0.5">Library items</div>
            <div className="tut-lib-item-1 rounded border border-slate-700 px-1.5 py-1 flex items-center gap-1" style={{ background: '#1e293b' }}>
              <BookOpen size={10} className="text-cyan-400" />
              <span className="text-[9px] font-mono text-slate-200 flex-1">GS pad</span>
              <Plus size={8} className="text-emerald-400" />
            </div>
            <div className="tut-lib-item-2 rounded border border-slate-700 px-1.5 py-1 flex items-center gap-1" style={{ background: '#1e293b' }}>
              <BookOpen size={10} className="text-cyan-400" />
              <span className="text-[9px] font-mono text-slate-200 flex-1">meander cell</span>
              <Plus size={8} className="text-emerald-400" />
            </div>
            <div className="tut-lib-item-3 rounded border border-slate-700 px-1.5 py-1 flex items-center gap-1 opacity-0" style={{ background: '#1e293b' }}>
              <BookOpen size={10} className="text-cyan-400" />
              <span className="text-[9px] font-mono text-emerald-300 flex-1">+ feed taper</span>
              <Plus size={8} className="text-emerald-400" />
            </div>
            <div className="border-t border-slate-700 mt-2 pt-1">
              <div className="text-[8px] text-slate-500 uppercase tracking-wider mb-0.5">Archive</div>
              <div className="text-[8px] text-slate-500 italic px-1">recoverable items live here</div>
            </div>
          </div>
        </div>
        {/* Canvas with shape being added to library */}
        <div className="flex-1 relative" style={{ background: '#020617' }}>
          <svg viewBox="0 0 240 200" className="w-full h-full" preserveAspectRatio="xMidYMid meet">
            {/* Selected cluster */}
            <g className="tut-lib-source">
              <rect x="60" y="60" width="50" height="80" fill="#daa520" fillOpacity="0.6" stroke="#fbbf24" strokeWidth="1.5" />
              <rect x="130" y="60" width="50" height="80" fill="#daa520" fillOpacity="0.6" stroke="#fbbf24" strokeWidth="1.5" />
              <rect x="60" y="60" width="50" height="80" fill="none" stroke="#0ea5e9" strokeWidth="1" strokeDasharray="3,2" />
              <rect x="130" y="60" width="50" height="80" fill="none" stroke="#0ea5e9" strokeWidth="1" strokeDasharray="3,2" />
            </g>
            <text className="tut-lib-source-label" x="120" y="155" fontSize="8" textAnchor="middle" fill="#94a3b8" fontFamily="monospace">selection</text>
            {/* Add-to-library button below */}
            <g className="tut-lib-add-btn" transform="translate(120, 175)">
              <rect x="-50" y="-9" width="100" height="18" rx="3" fill="#0e7490" />
              <text x="0" y="3" fontSize="8" textAnchor="middle" fill="#fff" fontFamily="monospace">+ library</text>
            </g>
          </svg>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// STEP 8 — Dimensioning
// Real dimensions button (violet when active) + canvas with parameter-
// bound arrows fading on every w/h/snap-offset.
// ─────────────────────────────────────────────────────────────────────
function DimensionDemo() {
  return (
    <div className="w-full h-full flex flex-col rounded overflow-hidden" style={{ background: '#0f172a' }}>
      <MiniHeader>
        <div className="flex-1" />
        {/* Issues button (red when issues; here clean) */}
        <div className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px]" style={{ background: '#334155', color: '#e2e8f0' }}>
          <AlertTriangle size={9} /> issues
        </div>
        {/* Grid button (real cyan when on) */}
        <div className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] bg-cyan-700 text-white">
          <Grid3x3 size={9} /> 1
        </div>
        {/* Fit */}
        <div className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] border border-slate-600 text-slate-200">
          <Maximize2 size={9} /> fit
        </div>
        {/* The dimensions button — animates active state */}
        <div className="tut-dim-btn flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] border border-slate-600 text-slate-200">
          <Ruler size={9} /> dimensions
        </div>
      </MiniHeader>
      <div className="flex-1 relative" style={{ background: '#020617' }}>
        <svg viewBox="0 0 360 200" className="w-full h-full" preserveAspectRatio="xMidYMid meet">
          <defs>
            <marker id="tut-dim-arr" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto">
              <path d="M 0 2 L 10 5 L 0 8 Z" fill="#a78bfa" />
            </marker>
          </defs>
          {/* Two electrodes — like a CPW signal/ground pair */}
          <rect x="60" y="95" width="100" height="40" fill="#daa520" fillOpacity="0.7" stroke="#fbbf24" strokeWidth="1.5" />
          <rect x="200" y="95" width="100" height="40" fill="#daa520" fillOpacity="0.7" stroke="#fbbf24" strokeWidth="1.5" />
          {/* Width arrow under signal */}
          <g className="tut-dim-w">
            <line x1="60" y1="148" x2="160" y2="148" stroke="#a78bfa" markerStart="url(#tut-dim-arr)" markerEnd="url(#tut-dim-arr)" />
            <text x="110" y="160" fontSize="9" textAnchor="middle" fill="#c4b5fd" fontFamily="monospace">w_sig</text>
          </g>
          {/* Height arrow right of signal */}
          <g className="tut-dim-h">
            <line x1="172" y1="95" x2="172" y2="135" stroke="#a78bfa" markerStart="url(#tut-dim-arr)" markerEnd="url(#tut-dim-arr)" />
            <text x="184" y="118" fontSize="9" fill="#c4b5fd" fontFamily="monospace">h_sig</text>
          </g>
          {/* Gap arrow */}
          <g className="tut-dim-gap">
            <line x1="160" y1="86" x2="200" y2="86" stroke="#a78bfa" markerStart="url(#tut-dim-arr)" markerEnd="url(#tut-dim-arr)" />
            <text x="180" y="78" fontSize="9" textAnchor="middle" fill="#c4b5fd" fontFamily="monospace">gap</text>
          </g>
        </svg>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// STEP 9 — Exporting
// Real export dropdown (cyan-bg) opening; menu items with lucide icons.
// ─────────────────────────────────────────────────────────────────────
function ExportDemo() {
  return (
    <div className="w-full h-full flex flex-col rounded overflow-hidden" style={{ background: '#0f172a' }}>
      <MiniHeader>
        <div className="flex-1" />
        {/* The export button — pulses */}
        <div className="tut-exp-btn flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium" style={{ background: '#06b6d4', color: '#0f172a' }}>
          <Download size={10} /> export
          <span className="text-[8px] opacity-80">▾</span>
        </div>
      </MiniHeader>
      <div className="flex-1 relative" style={{ background: '#020617' }}>
        {/* Dropdown menu opens from the button */}
        <div className="tut-exp-menu absolute top-1 right-2 w-44 rounded border border-slate-700 shadow-xl" style={{ background: '#1e293b' }}>
          <div className="py-1">
            <div className="px-2 py-1 flex items-center justify-between gap-1.5 text-[9px] text-slate-200">
              <div className="flex items-center gap-1.5"><Download size={9} /> pyAEDT</div>
              <span className="text-[7px] text-slate-500 font-mono">.py</span>
            </div>
            <div className="px-2 py-1 flex items-center justify-between gap-1.5 text-[9px] text-slate-200">
              <div className="flex items-center gap-1.5"><Download size={9} /> HFSS native</div>
              <span className="text-[7px] text-slate-500 font-mono">_hfss.py</span>
            </div>
            <div className="px-2 py-1 flex items-center justify-between gap-1.5 text-[9px] text-slate-200">
              <div className="flex items-center gap-1.5"><Download size={9} /> GDS-II</div>
              <span className="text-[7px] text-slate-500 font-mono">.gds</span>
            </div>
            <div className="px-2 py-1 flex items-center justify-between gap-1.5 text-[9px] text-slate-200">
              <div className="flex items-center gap-1.5"><Download size={9} /> gdsfactory</div>
              <span className="text-[7px] text-slate-500 font-mono">_gf.py</span>
            </div>
          </div>
        </div>
        {/* Files drop out */}
        <svg viewBox="0 0 360 200" className="w-full h-full" preserveAspectRatio="xMidYMid meet">
          <g className="tut-exp-file-1" transform="translate(60, 80)">
            <rect x="0" y="0" width="36" height="46" rx="2" fill="#fbbf24" stroke="#f59e0b" />
            <text x="18" y="22" fontSize="8" textAnchor="middle" fill="#3d2c00" fontFamily="monospace" fontWeight="bold">.py</text>
            <text x="18" y="38" fontSize="6" textAnchor="middle" fill="#3d2c00" fontFamily="monospace">pyAEDT</text>
          </g>
          <g className="tut-exp-file-2" transform="translate(120, 80)">
            <rect x="0" y="0" width="36" height="46" rx="2" fill="#06b6d4" stroke="#0891b2" />
            <text x="18" y="22" fontSize="8" textAnchor="middle" fill="#022c22" fontFamily="monospace" fontWeight="bold">.py</text>
            <text x="18" y="38" fontSize="6" textAnchor="middle" fill="#022c22" fontFamily="monospace">HFSS</text>
          </g>
          <g className="tut-exp-file-3" transform="translate(180, 80)">
            <rect x="0" y="0" width="36" height="46" rx="2" fill="#a78bfa" stroke="#8b5cf6" />
            <text x="18" y="22" fontSize="8" textAnchor="middle" fill="#1e1b4b" fontFamily="monospace" fontWeight="bold">.gds</text>
            <text x="18" y="38" fontSize="6" textAnchor="middle" fill="#1e1b4b" fontFamily="monospace">GDS-II</text>
          </g>
          <g className="tut-exp-file-4" transform="translate(240, 80)">
            <rect x="0" y="0" width="36" height="46" rx="2" fill="#10b981" stroke="#059669" />
            <text x="18" y="22" fontSize="8" textAnchor="middle" fill="#022c22" fontFamily="monospace" fontWeight="bold">.py</text>
            <text x="18" y="38" fontSize="6" textAnchor="middle" fill="#022c22" fontFamily="monospace">gf</text>
          </g>
        </svg>
      </div>
    </div>
  );
}

// ── Steps registry ───────────────────────────────────────────────────
const STEPS = [
  {
    id: 'stack',
    title: 'Layer stack',
    blurb: 'The LAYERS panel defines the physical Z order — substrate, waveguide core, conductor metal(s), cladding. Thicknesses are parameters so HFSS sweeps move the whole layout in lockstep.',
    Demo: StackDemo,
  },
  {
    id: 'draw',
    title: 'Drawing & layer selection',
    blurb: 'Pick a layer from the dropdown (Waveguide green / Conductor amber / Port red), then click a shape button (Square / Circle / Ellipse / Polyline / Racetrack) and drag on the canvas. The active layer drives the shape\'s color, material, and exported Z.',
    Demo: DrawingDemo,
  },
  {
    id: 'params',
    title: 'Parameters & scroll',
    blurb: 'Every dimension is an expression — w_wg, cap_d, feed_L… Edit them inline in PARAMS or scroll-wheel directly on any value field. The canvas updates live; selected-component\'s parameters get a cyan ring.',
    Demo: ParamsDemo,
  },
  {
    id: 'snap',
    title: 'Snapping',
    blurb: 'Hold ⌥ (Option) while dragging — the closest pair of anchors (corners / edges / center) attracts the moving shape. Release to commit; the snap becomes a parametric tie. The SNAPS panel lists every active snap with editable dx / dy expressions.',
    Demo: SnapDemo,
  },
  {
    id: 'ops',
    title: 'Operations',
    blurb: 'Multi-select + bool dropdown (Union / Intersect / Subtract / Punch) merges shapes HFSS-style — operands are consumed; the result is a derived component. Repeat / mirror / displace / rotate are per-component transforms in the chain editor.',
    Demo: OpsDemo,
  },
  {
    id: 'save',
    title: 'Saving — workspace · designs · versions',
    blurb: 'The workspace pill holds many designs, each with version history (snapshots). Save (green) writes the current design; the designs popout shows all of them. A "current" row floats above the latest snapshot so unsaved edits are obvious.',
    Demo: SaveDemo,
  },
  {
    id: 'lib',
    title: 'Library',
    blurb: 'Reusable snippets live in LIBRARY — a GS pad, a coupling region, a feed taper. Add to library from any selection; insert from library into any design. Archived items stay recoverable; deleted ones don\'t.',
    Demo: LibraryDemo,
  },
  {
    id: 'dim',
    title: 'Dimensioning',
    blurb: 'Toggle the dimensions button (turns violet) to overlay every parameter-bound width, height, and snap offset on the canvas. Variable names are the primary label; numeric values appear when there\'s room.',
    Demo: DimensionDemo,
  },
  {
    id: 'export',
    title: 'Exporting',
    blurb: 'Export drops the design as a script: pyAEDT (modern Python API), native HFSS COM (Python 2.7 inside HFSS), GDS-II for foundry tape-out, or a parametric @gf.cell gdsfactory function. Parameters become HFSS variables — sweep them without re-exporting.',
    Demo: ExportDemo,
  },
];

// ── CSS keyframes — one <style> block, scoped via class names ────────
const TUTORIAL_KEYFRAMES = `
/* Generic helpers */
@keyframes tut-fade-in {
  0% { opacity: 0; transform: translateY(6px); }
  100% { opacity: 1; transform: translateY(0); }
}
@keyframes tut-fade {
  0% { opacity: 0; } 18% { opacity: 1; } 90% { opacity: 1; } 100% { opacity: 0; }
}

/* ── Step 1: stack ── */
.tut-layer-card-1, .tut-layer-card-2, .tut-layer-card-3, .tut-layer-card-4, .tut-layer-card-5 {
  opacity: 0;
}
.tut-layer-card-5 { animation: tut-fade-in 0.5s 0.2s both; }
.tut-layer-card-4 { animation: tut-fade-in 0.5s 0.7s both; }
.tut-layer-card-3 { animation: tut-fade-in 0.5s 1.2s both; }
.tut-layer-card-2 { animation: tut-fade-in 0.5s 1.7s both; }
.tut-layer-card-1 { animation: tut-fade-in 0.5s 2.2s both; }
.tut-stack-bottom { opacity: 0; animation: tut-fade-in 0.5s 0.4s both; }
.tut-stack-box    { opacity: 0; animation: tut-fade-in 0.5s 0.9s both; }
.tut-stack-wg     { opacity: 0; animation: tut-fade-in 0.5s 1.4s both; }
.tut-stack-cond   { opacity: 0; animation: tut-fade-in 0.5s 1.9s both; }
.tut-stack-clad   { opacity: 0; animation: tut-fade-in 0.5s 2.4s both; }

/* ── Step 2: drawing & layer pick ── */
@keyframes tut-pill-cycle {
  0%, 28%   { background-color: #3ec27a; }   /* waveguide */
  33%, 61%  { background-color: #f4a72e; }   /* conductor */
  66%, 94%  { background-color: #b91c1c; color: #fee2e2; }   /* port */
  100%      { background-color: #3ec27a; color: #1f1300; }
}
.tut-layer-pill { animation: tut-pill-cycle 9s infinite; }
/* Label cycling — three stacked spans, each shown during one third of
   the 9s cycle. Synchronized with the pill-color keyframes above. */
.tut-label-wg   { animation: tut-label-show-wg 9s infinite; }
.tut-label-cond { animation: tut-label-show-cond 9s infinite; }
.tut-label-port { animation: tut-label-show-port 9s infinite; }
@keyframes tut-label-show-wg   { 0%, 28% { opacity: 1; } 33%, 95% { opacity: 0; } 100% { opacity: 1; } }
@keyframes tut-label-show-cond { 0%, 28% { opacity: 0; } 33%, 61% { opacity: 1; } 66%, 100% { opacity: 0; } }
@keyframes tut-label-show-port { 0%, 61% { opacity: 0; } 66%, 94% { opacity: 1; } 100% { opacity: 0; } }

/* Shape button — rectangle stays selected (green ring) */
.tut-shape-rect { box-shadow: 0 0 0 2px #4ade80; }

/* The drawn rectangles, animated to "drag" out */
.tut-draw-rect-wg { animation: tut-draw-wg 9s infinite; }
@keyframes tut-draw-wg {
  0%        { width: 0; opacity: 0; }
  5%        { width: 0; opacity: 1; }
  28%       { width: 220px; opacity: 1; }
  29%, 100% { width: 220px; opacity: 0.85; }
}
.tut-draw-rect-cond { animation: tut-draw-cond 9s infinite; }
@keyframes tut-draw-cond {
  0%, 33%   { width: 0; opacity: 0; }
  38%       { width: 0; opacity: 1; }
  61%       { width: 220px; opacity: 1; }
  62%, 100% { width: 220px; opacity: 0.85; }
}
.tut-draw-rect-port { animation: tut-draw-port 9s infinite; }
@keyframes tut-draw-port {
  0%, 66%   { width: 0; opacity: 0; }
  71%       { width: 0; opacity: 1; }
  94%       { width: 100px; opacity: 1; }
  95%, 100% { width: 100px; opacity: 0.85; }
}
@keyframes tut-cursor-draw {
  0%   { transform: translate(58px, 48px); }
  5%   { transform: translate(58px, 48px); }
  28%  { transform: translate(280px, 78px); }
  33%  { transform: translate(58px, 93px); }
  61%  { transform: translate(280px, 115px); }
  66%  { transform: translate(58px, 133px); }
  94%  { transform: translate(160px, 155px); }
  100% { transform: translate(58px, 48px); }
}
.tut-cursor-draw { animation: tut-cursor-draw 9s infinite; }

/* ── Step 3: param scroll ── */
@keyframes tut-param-cycle-text {
  0%, 100% { content: '1.2'; }
  25% { content: '0.8'; }
  50% { content: '1.6'; }
  75% { content: '0.5'; }
}
/* Value cycling — animate width of the live waveguide rib */
.tut-live-wg-rib { animation: tut-live-wg 5s infinite; }
@keyframes tut-live-wg {
  0%, 100% { width: 24px; x: 88px; }
  25%      { width: 16px; x: 92px; }
  50%      { width: 32px; x: 84px; }
  75%      { width: 10px; x: 95px; }
}
.tut-live-dim { animation: tut-live-dim 5s infinite; }
@keyframes tut-live-dim {
  0%, 100% { x1: 88px; x2: 112px; }
  25%      { x1: 92px; x2: 108px; }
  50%      { x1: 84px; x2: 116px; }
  75%      { x1: 95px; x2: 105px; }
}
.tut-scroll-hint { animation: tut-scroll-bounce 1.2s infinite; opacity: 0.7; }
@keyframes tut-scroll-bounce {
  0%, 100% { transform: translateY(-50%) translateY(0); }
  50%      { transform: translateY(-50%) translateY(-3px); }
}

/* ── Step 4: snap ── */
@keyframes tut-snap-cursor-move {
  0%, 10%  { transform: translate(110px, 100px); }
  45%      { transform: translate(220px, 100px); }
  60%      { transform: translate(225px, 100px); }
  100%     { transform: translate(225px, 100px); }
}
.tut-snap-cursor { animation: tut-snap-cursor-move 5s infinite; }
@keyframes tut-snap-mover-move {
  0%, 10%  { transform: translate(100px, 100px); }
  45%      { transform: translate(210px, 100px); }
  60%      { transform: translate(225px, 100px); }
  100%     { transform: translate(225px, 100px); }
}
.tut-snap-mover { animation: tut-snap-mover-move 5s infinite; }
@keyframes tut-anchor-glow {
  0%, 30%   { opacity: 0; r: 4; }
  35%, 55%  { opacity: 1; r: 6; }
  60%, 100% { opacity: 1; r: 4; }
}
.tut-snap-anchor-mover, .tut-snap-anchor-target { animation: tut-anchor-glow 5s infinite; }
@keyframes tut-opt-glow {
  0%, 15%   { opacity: 0; transform: scale(0.85); }
  20%, 70%  { opacity: 1; transform: scale(1); }
  75%, 100% { opacity: 0.4; transform: scale(0.92); }
}
.tut-opt-badge { animation: tut-opt-glow 5s infinite; transform-origin: 36px 24px; }
@keyframes tut-snap-link-show {
  0%, 55%   { opacity: 0; }
  60%, 95%  { opacity: 1; x1: 250px; y1: 100px; x2: 228px; y2: 100px; }
  96%, 100% { opacity: 0; }
}
.tut-snap-link { animation: tut-snap-link-show 5s infinite; }
@keyframes tut-snap-row-in {
  0%, 65%   { opacity: 0; transform: translateY(-4px); }
  72%, 100% { opacity: 1; transform: translateY(0); }
}
.tut-snap-row { animation: tut-snap-row-in 5s infinite; }

/* ── Step 5: bool dropdown + repeat ── */
@keyframes tut-bool-menu-show {
  0%, 8%    { opacity: 0; transform: translateY(-6px); }
  14%, 60%  { opacity: 1; transform: translateY(0); }
  68%, 100% { opacity: 0; transform: translateY(-6px); }
}
.tut-bool-menu { animation: tut-bool-menu-show 6s infinite; }
@keyframes tut-bool-btn-pulse {
  0%, 6%    { box-shadow: none; }
  10%, 50%  { box-shadow: 0 0 0 2px #67e8f9; }
}
.tut-bool-btn { animation: tut-bool-btn-pulse 6s infinite; }
@keyframes tut-bool-subtract-hl {
  0%, 30%  { background: transparent; }
  35%, 55% { background: rgba(14,116,144,0.55); }
  60%, 100% { background: transparent; }
}
.tut-bool-subtract { animation: tut-bool-subtract-hl 6s infinite; }
@keyframes tut-ops-tool {
  0%, 55%  { opacity: 0; r: 0; }
  60%, 100% { opacity: 1; r: 16; }
}
.tut-ops-sub-tool, .tut-ops-sub-tool-outline { animation: tut-ops-tool 6s infinite; }
@keyframes tut-ops-rep-show {
  0%, 25%  { opacity: 0; }
  35%, 100% { opacity: 0.85; }
}
.tut-ops-rep-2 { animation: tut-ops-rep-show 6s 0.2s infinite; }
.tut-ops-rep-3 { animation: tut-ops-rep-show 6s 0.5s infinite; }
.tut-ops-rep-4 { animation: tut-ops-rep-show 6s 0.8s infinite; }
.tut-ops-rep-hint { opacity: 0; animation: tut-fade 6s 1s infinite; }

/* ── Step 6: save / designs ── */
@keyframes tut-save-pulse {
  0%, 25%, 60%, 100% { box-shadow: none; }
  30%, 35%   { box-shadow: 0 0 0 2px #fff; }
}
.tut-save-btn { animation: tut-save-pulse 6s infinite; }
@keyframes tut-designs-popout-show {
  0%, 35%  { opacity: 0; transform: scale(0.95) translateY(-4px); }
  45%, 100% { opacity: 1; transform: scale(1) translateY(0); }
}
.tut-designs-popout { animation: tut-designs-popout-show 6s infinite; transform-origin: top right; }
.tut-save-v1 { opacity: 0; animation: tut-fade-in 0.4s 1.0s both infinite alternate; }
.tut-save-v2 { opacity: 0; animation: tut-fade-in 0.4s 1.5s both infinite alternate; }
.tut-save-v3 { opacity: 0; animation: tut-fade-in 0.4s 2.0s both infinite alternate; }
.tut-save-v-current { opacity: 0; animation: tut-fade-in 0.4s 2.5s both infinite alternate; }
.tut-save-design-2 { opacity: 0; animation: tut-fade-in 0.4s 3.5s both infinite alternate; }
.tut-save-designs-btn { animation: tut-save-pulse 6s 0.4s infinite; }

/* ── Step 7: library ── */
@keyframes tut-lib-shape-leave {
  0%, 20%  { opacity: 1; transform: translate(0, 0) scale(1); }
  45%      { opacity: 0.8; transform: translate(-120px, -20px) scale(0.6); }
  55%, 100% { opacity: 0; transform: translate(-120px, -20px) scale(0.5); }
}
.tut-lib-source { animation: tut-lib-shape-leave 5s infinite; }
.tut-lib-source-label { animation: tut-lib-shape-leave 5s infinite; }
@keyframes tut-lib-btn-pulse {
  0%, 18%  { box-shadow: none; }
  22%, 38% { filter: brightness(1.4); }
  40%, 100% { filter: brightness(1); }
}
.tut-lib-add-btn { animation: tut-lib-btn-pulse 5s infinite; }
@keyframes tut-lib-item-appear {
  0%, 50%  { opacity: 0; transform: translateX(-4px); }
  60%, 100% { opacity: 1; transform: translateX(0); }
}
.tut-lib-item-3 { animation: tut-lib-item-appear 5s infinite; }

/* ── Step 8: dimensions ── */
@keyframes tut-dim-btn-on {
  0%, 25%   { background-color: transparent; color: #e2e8f0; border-color: #475569; }
  30%, 100% { background-color: #7c3aed; color: #fff; border-color: #7c3aed; }
}
.tut-dim-btn { animation: tut-dim-btn-on 4s infinite; }
.tut-dim-w   { opacity: 0; animation: tut-fade 4s 0.3s infinite; }
.tut-dim-h   { opacity: 0; animation: tut-fade 4s 0.8s infinite; }
.tut-dim-gap { opacity: 0; animation: tut-fade 4s 1.3s infinite; }

/* ── Step 9: export ── */
@keyframes tut-exp-btn-pulse {
  0%, 10%  { box-shadow: none; }
  18%, 35% { box-shadow: 0 0 0 2px #fff; }
}
.tut-exp-btn { animation: tut-exp-btn-pulse 5s infinite; }
@keyframes tut-exp-menu-show {
  0%, 15%  { opacity: 0; transform: scale(0.95) translateY(-4px); }
  22%, 100% { opacity: 1; transform: scale(1) translateY(0); }
}
.tut-exp-menu { animation: tut-exp-menu-show 5s infinite; transform-origin: top right; }
@keyframes tut-exp-file {
  0%, 35%  { opacity: 0; transform: translate(0, -20px) rotate(-8deg); }
  50%      { opacity: 1; }
  100%     { opacity: 1; transform: translate(0, 30px) rotate(0); }
}
.tut-exp-file-1 { animation: tut-exp-file 5s 1.0s infinite both; }
.tut-exp-file-2 { animation: tut-exp-file 5s 1.4s infinite both; }
.tut-exp-file-3 { animation: tut-exp-file 5s 1.8s infinite both; }
.tut-exp-file-4 { animation: tut-exp-file 5s 2.2s infinite both; }
`;

// ── Main component ───────────────────────────────────────────────────
export function HelpTutorial({ open, onClose }) {
  const [step, setStep] = useState(0);
  // Re-mount the demo on each step change so CSS animations restart
  // from frame 0.
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (open) { setStep(0); setTick(t => t + 1); }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose?.(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
      else if (e.key === 'ArrowLeft')  { e.preventDefault(); prev(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step]);

  if (!open) return null;

  const next = () => {
    if (step < STEPS.length - 1) { setStep(step + 1); setTick(t => t + 1); }
  };
  const prev = () => {
    if (step > 0) { setStep(step - 1); setTick(t => t + 1); }
  };
  const goTo = (i) => { setStep(i); setTick(t => t + 1); };

  const s = STEPS[step];
  const Demo = s.Demo;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(2,6,23,0.75)' }}
      onClick={onClose}
    >
      <style>{TUTORIAL_KEYFRAMES}</style>
      <div
        className="rounded-lg border border-slate-700 shadow-2xl flex flex-col"
        style={{ background: '#0f172a', width: 'min(760px, 96vw)', height: 'min(600px, 92vh)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-2.5 border-b border-slate-700 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-slate-200">{s.title}</span>
            <span className="text-[10px] text-slate-500 font-mono">step {step + 1} / {STEPS.length}</span>
          </div>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-slate-200 text-xs"
            title="Close (Esc)"
          >✕</button>
        </div>

        <div className="flex-1 flex flex-col px-4 pt-3 pb-1 overflow-hidden">
          <div
            className="rounded border border-slate-800 overflow-hidden"
            style={{ background: '#020617', flex: '1 1 auto', minHeight: 0 }}
          >
            <div key={`${step}-${tick}`} style={{ width: '100%', height: '100%' }}>
              <Demo />
            </div>
          </div>
          <p className="text-xs text-slate-300 leading-relaxed mt-3 px-1">
            {s.blurb}
          </p>
        </div>

        <div className="px-4 py-3 border-t border-slate-700 flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            {STEPS.map((_, i) => (
              <button
                key={i}
                onClick={() => goTo(i)}
                className={`rounded-full transition-all ${
                  i === step
                    ? 'bg-cyan-400 w-4 h-2'
                    : 'bg-slate-600 hover:bg-slate-400 w-2 h-2'
                }`}
                title={STEPS[i].title}
                aria-label={`Go to step ${i + 1}: ${STEPS[i].title}`}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={prev}
              disabled={step === 0}
              className="px-3 py-1 rounded text-xs border border-slate-600 text-slate-300 hover:bg-slate-800 disabled:opacity-30"
            >
              ← Prev
            </button>
            {step < STEPS.length - 1 ? (
              <button
                onClick={next}
                className="px-3 py-1 rounded text-xs font-medium"
                style={{ background: '#06b6d4', color: '#0f172a' }}
              >
                Next →
              </button>
            ) : (
              <button
                onClick={onClose}
                className="px-3 py-1 rounded text-xs font-medium"
                style={{ background: '#10b981', color: '#022c22' }}
              >
                Done ✓
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
