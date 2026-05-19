// HelpTutorial — an animated walkthrough of the app's main capabilities.
//
// Opened from the "?" button in the header. Renders a modal overlay with
// a sequence of small SVG mini-demos, one per topic. The user steps
// through with Prev / Next; each step re-mounts the demo so the CSS
// keyframe animations restart cleanly.
//
// Demos are intentionally cartoon-style and not pixel-accurate against
// the real app — the goal is to convey the GESTURE and the OUTCOME,
// not to mirror exact UI chrome. Keeping the SVG light makes the help
// modal load instantly even on mobile / low-bandwidth.
import React, { useEffect, useState } from 'react';

// ── Step content ──────────────────────────────────────────────────────
// Each step is { id, title, blurb, Demo: ComponentFn }. Demo receives
// `key` from the parent (the step index + tick) so React re-mounts it
// on step change, restarting any CSS animations from frame 0.

// Step 1 — layer stack: substrate, waveguide core, conductor metal,
// cladding. Each fades / slides in with a stagger so the user reads
// the order bottom-up.
function StackDemo() {
  return (
    <svg viewBox="0 0 400 200" className="w-full h-full">
      <defs>
        <linearGradient id="sub-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#475569" />
          <stop offset="1" stopColor="#1e293b" />
        </linearGradient>
      </defs>
      {/* Substrate (bottom-most slab) */}
      <g style={{ animation: 'tut-slide-up 0.6s 0.2s both' }}>
        <rect x="40" y="140" width="320" height="40" fill="url(#sub-grad)" stroke="#64748b" />
        <text x="200" y="167" fontSize="11" textAnchor="middle" fill="#cbd5e1" fontFamily="monospace">substrate (Si / LiNbO₃)</text>
      </g>
      {/* Waveguide core */}
      <g style={{ animation: 'tut-slide-up 0.6s 0.9s both' }}>
        <rect x="40" y="110" width="320" height="22" fill="#10b981" stroke="#34d399" />
        <text x="200" y="126" fontSize="10" textAnchor="middle" fill="#022c22" fontFamily="monospace">waveguide core (h_wg)</text>
      </g>
      {/* Conductor metal */}
      <g style={{ animation: 'tut-slide-up 0.6s 1.5s both' }}>
        <rect x="60" y="84" width="80" height="18" fill="#daa520" stroke="#fbbf24" />
        <rect x="260" y="84" width="80" height="18" fill="#daa520" stroke="#fbbf24" />
        <text x="200" y="98" fontSize="10" textAnchor="middle" fill="#fbbf24" fontFamily="monospace">conductor (h_cond)</text>
      </g>
      {/* Cladding */}
      <g style={{ animation: 'tut-slide-up 0.6s 2.1s both' }}>
        <rect x="40" y="56" width="320" height="22" fill="#0ea5e9" fillOpacity="0.25" stroke="#38bdf8" strokeDasharray="3,2" />
        <text x="200" y="72" fontSize="10" textAnchor="middle" fill="#7dd3fc" fontFamily="monospace">cladding (SiO₂)</text>
      </g>
      {/* Caption arrow */}
      <g style={{ animation: 'tut-fade 0.6s 2.7s both' }}>
        <text x="200" y="36" fontSize="11" textAnchor="middle" fill="#94a3b8" fontFamily="monospace">
          STACK → physical Z order of every layer
        </text>
      </g>
    </svg>
  );
}

// Step 2 — drawing & layer selection. A layer dropdown cycles through
// waveguide → electrode → port (color flashes), and the cursor draws
// out a rectangle of the matching color underneath.
function DrawingDemo() {
  return (
    <svg viewBox="0 0 400 200" className="w-full h-full">
      <defs>
        <style>{`
          .layer-pill { animation: tut-pill-cycle 6s infinite; }
          .layer-rect-wg { animation: tut-draw-wg 6s infinite; }
          .layer-rect-elec { animation: tut-draw-elec 6s infinite; }
          .layer-rect-port { animation: tut-draw-port 6s infinite; }
          .cursor-1 { animation: tut-cursor-1 6s infinite; }
        `}</style>
      </defs>
      {/* The layer-selector mock pill, top of frame. Color cycles */}
      <g className="layer-pill">
        <rect x="20" y="20" width="100" height="22" rx="4" fill="#10b981" stroke="#34d399" />
        <text x="70" y="35" fontSize="11" textAnchor="middle" fill="#022c22" fontFamily="monospace" fontWeight="bold">layer</text>
        <polygon points="105,28 115,28 110,36" fill="#022c22" />
      </g>
      <text x="130" y="34" fontSize="10" fill="#94a3b8" fontFamily="monospace">pick layer → draw</text>
      {/* Three rectangles draw progressively */}
      <rect className="layer-rect-wg" x="50" y="80" width="0" height="20" fill="#10b981" stroke="#34d399" />
      <text x="60" y="93" fontSize="9" fill="#022c22" fontFamily="monospace" style={{ animation: 'tut-rect-label-wg 6s infinite' }}>wg</text>
      <rect className="layer-rect-elec" x="50" y="115" width="0" height="18" fill="#daa520" stroke="#fbbf24" />
      <text x="60" y="127" fontSize="9" fill="#3d2c00" fontFamily="monospace" style={{ animation: 'tut-rect-label-elec 6s infinite' }}>elec</text>
      <rect className="layer-rect-port" x="50" y="150" width="0" height="18" fill="#b91c1c" stroke="#ef4444" fillOpacity="0.55" />
      <text x="60" y="162" fontSize="9" fill="#fee2e2" fontFamily="monospace" style={{ animation: 'tut-rect-label-port 6s infinite' }}>port</text>
      {/* Cursor follows the drag */}
      <g className="cursor-1">
        <path d="M 0 0 L 0 14 L 4 10 L 7 16 L 9 15 L 6 9 L 12 9 Z" fill="#fff" stroke="#0f172a" strokeWidth="0.5" />
      </g>
    </svg>
  );
}

// Step 3 — parameters & scroll. Show a "w_wg = 0.5" parameter row;
// cursor sits on the value, scrolls; the value increments + a small
// waveguide preview widens in lockstep.
function ParamsDemo() {
  return (
    <svg viewBox="0 0 400 200" className="w-full h-full">
      <defs>
        <style>{`
          .param-value { animation: tut-param-cycle 4s infinite; }
          .scroll-wheel { animation: tut-scroll-bounce 4s infinite; }
          .live-wg { animation: tut-live-wg 4s infinite; }
        `}</style>
      </defs>
      {/* Parameter row */}
      <rect x="40" y="40" width="320" height="36" rx="4" fill="#0f172a" stroke="#334155" />
      <text x="56" y="63" fontSize="13" fill="#67e8f9" fontFamily="monospace">w_wg</text>
      <text x="120" y="63" fontSize="13" fill="#94a3b8" fontFamily="monospace">=</text>
      <text x="148" y="63" fontSize="13" fill="#fbbf24" fontFamily="monospace" className="param-value">0.5</text>
      <text x="210" y="63" fontSize="11" fill="#64748b" fontFamily="monospace">µm</text>
      {/* Scroll-wheel icon */}
      <g transform="translate(290, 49)" className="scroll-wheel">
        <rect x="-8" y="-8" width="16" height="22" rx="8" fill="none" stroke="#94a3b8" strokeWidth="1.5" />
        <line x1="0" y1="-4" x2="0" y2="2" stroke="#94a3b8" strokeWidth="1.5" />
      </g>
      <text x="305" y="63" fontSize="10" fill="#94a3b8" fontFamily="monospace">scroll ↕</text>
      {/* Live preview */}
      <text x="120" y="120" fontSize="10" fill="#94a3b8" fontFamily="monospace">live preview ↓</text>
      <g transform="translate(80, 140)">
        <rect x="0" y="-2" width="240" height="4" fill="#1e293b" />
        <rect className="live-wg" x="0" y="-10" width="240" height="20" fill="#10b981" stroke="#34d399" />
      </g>
      <text x="200" y="185" fontSize="10" textAnchor="middle" fill="#64748b" fontFamily="monospace">
        scroll on a value to retune — geometry updates live
      </text>
    </svg>
  );
}

// Step 4 — snapping. Two boxes; opt-drag attracts anchors with pink
// crosses; release commits the snap.
function SnapDemo() {
  return (
    <svg viewBox="0 0 400 200" className="w-full h-full">
      <defs>
        <style>{`
          .snap-cursor { animation: tut-snap-cursor 5s infinite; }
          .snap-target { animation: tut-snap-target 5s infinite; }
          .snap-mover { animation: tut-snap-mover 5s infinite; }
          .snap-cross-a { animation: tut-snap-cross 5s infinite; }
          .snap-cross-b { animation: tut-snap-cross-b 5s infinite; }
          .opt-badge { animation: tut-opt-badge 5s infinite; }
          .snap-link { animation: tut-snap-link 5s infinite; }
        `}</style>
      </defs>
      {/* Fixed target box (right) */}
      <g className="snap-target" transform="translate(260, 80)">
        <rect x="-30" y="-25" width="60" height="50" fill="#10b981" stroke="#34d399" strokeWidth="1.5" />
        <circle className="snap-cross-b" cx="-30" cy="0" r="4" fill="#ec4899" />
      </g>
      {/* Movable box (slides toward target on opt-drag) */}
      <g className="snap-mover">
        <rect x="-30" y="-25" width="60" height="50" fill="#daa520" stroke="#fbbf24" strokeWidth="1.5" />
        <circle className="snap-cross-a" cx="30" cy="0" r="4" fill="#ec4899" />
      </g>
      {/* Snap connection (dashed line that appears when locked) */}
      <line className="snap-link" x1="0" y1="0" x2="0" y2="0" stroke="#ec4899" strokeWidth="1.5" strokeDasharray="3,2" />
      {/* Cursor */}
      <g className="snap-cursor">
        <path d="M 0 0 L 0 14 L 4 10 L 7 16 L 9 15 L 6 9 L 12 9 Z" fill="#fff" stroke="#0f172a" strokeWidth="0.5" />
      </g>
      {/* Option-key badge */}
      <g className="opt-badge" transform="translate(40, 30)">
        <rect x="0" y="0" width="44" height="22" rx="4" fill="#1e293b" stroke="#ec4899" />
        <text x="22" y="15" fontSize="11" textAnchor="middle" fill="#f9a8d4" fontFamily="monospace" fontWeight="bold">⌥ OPT</text>
      </g>
      <text x="200" y="175" fontSize="10" textAnchor="middle" fill="#64748b" fontFamily="monospace">
        hold ⌥ while dragging — closest anchor pair snaps; release to lock
      </text>
    </svg>
  );
}

// Step 5 — operations. Two circles → union → blob. Then a single rect
// repeats into an array.
function OpsDemo() {
  return (
    <svg viewBox="0 0 400 200" className="w-full h-full">
      <defs>
        <style>{`
          .ops-left-circle { animation: tut-ops-cl 4s infinite; }
          .ops-right-circle { animation: tut-ops-cr 4s infinite; }
          .ops-union-glow { animation: tut-ops-glow 4s infinite; }
          .ops-rect-1 { animation: tut-ops-rect-1 4s 0.5s infinite; }
          .ops-rect-2 { animation: tut-ops-rect-2 4s 0.5s infinite; }
          .ops-rect-3 { animation: tut-ops-rect-3 4s 0.5s infinite; }
        `}</style>
      </defs>
      {/* LEFT: boolean union */}
      <text x="100" y="32" fontSize="11" textAnchor="middle" fill="#67e8f9" fontFamily="monospace" fontWeight="bold">UNION</text>
      <circle className="ops-left-circle" cx="80" cy="100" r="32" fill="#daa520" fillOpacity="0.7" stroke="#fbbf24" />
      <circle className="ops-right-circle" cx="120" cy="100" r="32" fill="#daa520" fillOpacity="0.7" stroke="#fbbf24" />
      <ellipse className="ops-union-glow" cx="100" cy="100" rx="0" ry="0" fill="none" stroke="#10b981" strokeWidth="2" />
      <text x="100" y="155" fontSize="9" textAnchor="middle" fill="#94a3b8" fontFamily="monospace">two shapes → one</text>

      {/* Center separator */}
      <line x1="200" y1="50" x2="200" y2="160" stroke="#334155" strokeDasharray="2,2" />

      {/* RIGHT: repeat */}
      <text x="300" y="32" fontSize="11" textAnchor="middle" fill="#67e8f9" fontFamily="monospace" fontWeight="bold">REPEAT</text>
      <rect className="ops-rect-1" x="240" y="80" width="30" height="40" fill="#daa520" stroke="#fbbf24" />
      <rect className="ops-rect-2" x="285" y="80" width="30" height="40" fill="#daa520" stroke="#fbbf24" opacity="0" />
      <rect className="ops-rect-3" x="330" y="80" width="30" height="40" fill="#daa520" stroke="#fbbf24" opacity="0" />
      <text x="300" y="155" fontSize="9" textAnchor="middle" fill="#94a3b8" fontFamily="monospace">one shape → N</text>

      <text x="200" y="185" fontSize="10" textAnchor="middle" fill="#64748b" fontFamily="monospace">
        bool · mirror · repeat · displace · rotate — all in the transform chain
      </text>
    </svg>
  );
}

// Step 6 — saving / workspaces / designs / versions.
function SaveDemo() {
  return (
    <svg viewBox="0 0 400 200" className="w-full h-full">
      <defs>
        <style>{`
          .save-icon { animation: tut-save-icon 6s infinite; }
          .save-row-1 { animation: tut-save-row-1 6s infinite; }
          .save-row-2 { animation: tut-save-row-2 6s infinite; }
          .save-version-1 { animation: tut-version-1 6s infinite; }
          .save-version-2 { animation: tut-version-2 6s infinite; }
          .save-version-3 { animation: tut-version-3 6s infinite; }
        `}</style>
      </defs>
      {/* Workspace label, top */}
      <rect x="20" y="14" width="120" height="20" rx="3" fill="#164e63" stroke="#0e7490" />
      <text x="80" y="28" fontSize="10" textAnchor="middle" fill="#a5f3fc" fontFamily="monospace">📁 workspace</text>
      <text x="148" y="28" fontSize="10" fill="#64748b" fontFamily="monospace">→ many designs, libraries, archive</text>

      {/* Design list (left column) */}
      <text x="20" y="58" fontSize="9" fill="#64748b" fontFamily="monospace">DESIGNS</text>
      <rect className="save-row-1" x="20" y="64" width="140" height="20" rx="3" fill="#0f172a" stroke="#334155" />
      <text x="30" y="78" fontSize="10" fill="#cbd5e1" fontFamily="monospace" style={{ animation: 'tut-save-row-1 6s infinite' }}>my_modulator</text>
      <rect className="save-row-2" x="20" y="88" width="140" height="20" rx="3" fill="#0f172a" stroke="#334155" opacity="0" />
      <text x="30" y="102" fontSize="10" fill="#cbd5e1" fontFamily="monospace" style={{ animation: 'tut-save-row-2 6s infinite' }}>filter_v2</text>

      {/* Version list (right column) */}
      <text x="200" y="58" fontSize="9" fill="#64748b" fontFamily="monospace">VERSIONS (snapshots)</text>
      <rect className="save-version-1" x="200" y="64" width="180" height="20" rx="3" fill="#1e293b" stroke="#475569" opacity="0" />
      <text x="210" y="78" fontSize="10" fill="#a5f3fc" fontFamily="monospace" style={{ animation: 'tut-version-1 6s infinite' }}>v1 — initial</text>
      <rect className="save-version-2" x="200" y="88" width="180" height="20" rx="3" fill="#1e293b" stroke="#475569" opacity="0" />
      <text x="210" y="102" fontSize="10" fill="#a5f3fc" fontFamily="monospace" style={{ animation: 'tut-version-2 6s infinite' }}>v2 — w_wg=0.6</text>
      <rect className="save-version-3" x="200" y="112" width="180" height="20" rx="3" fill="#1e293b" stroke="#475569" opacity="0" />
      <text x="210" y="126" fontSize="10" fill="#fbbf24" fontFamily="monospace" style={{ animation: 'tut-version-3 6s infinite' }}>current ✏ (in progress)</text>

      {/* Save button (lower-left) */}
      <g className="save-icon" transform="translate(60, 160)">
        <rect x="-26" y="-12" width="52" height="22" rx="3" fill="#06b6d4" />
        <text x="0" y="3" fontSize="11" textAnchor="middle" fill="#0f172a" fontFamily="monospace" fontWeight="bold">💾 save</text>
      </g>
      <text x="200" y="190" fontSize="10" textAnchor="middle" fill="#64748b" fontFamily="monospace">
        workspaces → designs → snapshots (full version history)
      </text>
    </svg>
  );
}

// Step 7 — libraries. A reusable snippet drags from canvas into the
// library panel, then drags back into a different design.
function LibraryDemo() {
  return (
    <svg viewBox="0 0 400 200" className="w-full h-full">
      <defs>
        <style>{`
          .lib-shape { animation: tut-lib-shape 6s infinite; }
          .lib-icon { animation: tut-lib-icon 6s infinite; }
          .lib-cursor { animation: tut-lib-cursor 6s infinite; }
          .lib-reuse { animation: tut-lib-reuse 6s infinite; }
        `}</style>
      </defs>
      {/* Library panel (right) */}
      <rect x="280" y="30" width="100" height="140" rx="4" fill="#0f172a" stroke="#334155" strokeWidth="1.5" />
      <text x="330" y="46" fontSize="10" textAnchor="middle" fill="#67e8f9" fontFamily="monospace">📚 LIBRARY</text>
      <rect className="lib-icon" x="294" y="58" width="72" height="40" rx="3" fill="#1e293b" stroke="#475569" opacity="0" />
      <text x="330" y="82" fontSize="9" textAnchor="middle" fill="#cbd5e1" fontFamily="monospace" style={{ animation: 'tut-lib-icon-text 6s infinite' }}>GS pad</text>
      {/* Source canvas (left) */}
      <text x="20" y="26" fontSize="10" fill="#64748b" fontFamily="monospace">design A</text>
      <rect x="20" y="32" width="140" height="100" rx="4" fill="#020617" stroke="#334155" strokeDasharray="3,2" />
      <g className="lib-shape" transform="translate(90, 82)">
        <rect x="-22" y="-15" width="44" height="30" fill="#daa520" stroke="#fbbf24" />
      </g>
      {/* Reuse: new design panel below, library shape drops in */}
      <text x="20" y="156" fontSize="10" fill="#64748b" fontFamily="monospace">design B</text>
      <rect x="20" y="160" width="140" height="36" rx="4" fill="#020617" stroke="#334155" strokeDasharray="3,2" />
      <g className="lib-reuse" transform="translate(90, 178)">
        <rect x="-22" y="-12" width="44" height="24" fill="#daa520" stroke="#fbbf24" opacity="0" />
      </g>
      {/* Cursor */}
      <g className="lib-cursor">
        <path d="M 0 0 L 0 14 L 4 10 L 7 16 L 9 15 L 6 9 L 12 9 Z" fill="#fff" stroke="#0f172a" strokeWidth="0.5" />
      </g>
    </svg>
  );
}

// Step 8 — dimensioning. Click the ruler button → every parameter-
// bound width / height / snap offset gets a labeled arrow.
function DimensionDemo() {
  return (
    <svg viewBox="0 0 400 200" className="w-full h-full">
      <defs>
        <style>{`
          .dim-button { animation: tut-dim-btn 4s infinite; }
          .dim-arrow-w { animation: tut-fade 4s 0.8s infinite; }
          .dim-arrow-h { animation: tut-fade 4s 1.4s infinite; }
          .dim-arrow-gap { animation: tut-fade 4s 2.0s infinite; }
        `}</style>
        <marker id="dim-arr" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M 0 2 L 10 5 L 0 8 Z" fill="#a78bfa" />
        </marker>
      </defs>
      {/* Ruler button */}
      <g className="dim-button" transform="translate(60, 30)">
        <rect x="0" y="0" width="100" height="22" rx="3" fill="#7c3aed" />
        <text x="50" y="15" fontSize="11" textAnchor="middle" fill="#fff" fontFamily="monospace">📏 dimensions</text>
      </g>
      {/* Two electrodes with a gap */}
      <rect x="80" y="100" width="80" height="40" fill="#daa520" stroke="#fbbf24" />
      <rect x="220" y="100" width="80" height="40" fill="#daa520" stroke="#fbbf24" />
      {/* Width arrow (under first rect) */}
      <g className="dim-arrow-w">
        <line x1="80" y1="155" x2="160" y2="155" stroke="#a78bfa" markerStart="url(#dim-arr)" markerEnd="url(#dim-arr)" />
        <text x="120" y="170" fontSize="10" textAnchor="middle" fill="#c4b5fd" fontFamily="monospace">w_pad</text>
      </g>
      {/* Height arrow (right of first rect) */}
      <g className="dim-arrow-h">
        <line x1="170" y1="100" x2="170" y2="140" stroke="#a78bfa" markerStart="url(#dim-arr)" markerEnd="url(#dim-arr)" />
        <text x="180" y="124" fontSize="10" fill="#c4b5fd" fontFamily="monospace">h_pad</text>
      </g>
      {/* Gap arrow (between the two) */}
      <g className="dim-arrow-gap">
        <line x1="160" y1="90" x2="220" y2="90" stroke="#a78bfa" markerStart="url(#dim-arr)" markerEnd="url(#dim-arr)" />
        <text x="190" y="84" fontSize="10" textAnchor="middle" fill="#c4b5fd" fontFamily="monospace">gap</text>
      </g>
      <text x="200" y="190" fontSize="10" textAnchor="middle" fill="#64748b" fontFamily="monospace">
        toggle to overlay every parameter-bound dimension on the canvas
      </text>
    </svg>
  );
}

// Step 9 — exporting as a script. Click "export" → pyAEDT.py drops out
// of the menu.
function ExportDemo() {
  return (
    <svg viewBox="0 0 400 200" className="w-full h-full">
      <defs>
        <style>{`
          .exp-btn { animation: tut-exp-btn 5s infinite; }
          .exp-menu { animation: tut-exp-menu 5s infinite; }
          .exp-file-py { animation: tut-exp-file 5s 1.2s infinite; }
          .exp-file-hfss { animation: tut-exp-file 5s 2s infinite; }
          .exp-file-gds { animation: tut-exp-file 5s 2.8s infinite; }
        `}</style>
      </defs>
      {/* Export button */}
      <g className="exp-btn" transform="translate(40, 30)">
        <rect x="0" y="0" width="84" height="22" rx="3" fill="#0891b2" />
        <text x="42" y="15" fontSize="11" textAnchor="middle" fill="#fff" fontFamily="monospace">↓ export ▾</text>
      </g>
      {/* Dropdown menu */}
      <g className="exp-menu">
        <rect x="40" y="56" width="160" height="80" rx="3" fill="#0f172a" stroke="#334155" />
        <text x="50" y="72" fontSize="10" fill="#cbd5e1" fontFamily="monospace">pyAEDT (.py)</text>
        <text x="50" y="90" fontSize="10" fill="#cbd5e1" fontFamily="monospace">HFSS native (.py)</text>
        <text x="50" y="108" fontSize="10" fill="#cbd5e1" fontFamily="monospace">GDS-II (.gds)</text>
        <text x="50" y="126" fontSize="10" fill="#cbd5e1" fontFamily="monospace">design JSON</text>
      </g>
      {/* File icons that drop out */}
      <g className="exp-file-py" transform="translate(240, 70)">
        <rect x="0" y="0" width="40" height="50" rx="2" fill="#fbbf24" stroke="#f59e0b" />
        <text x="20" y="30" fontSize="9" textAnchor="middle" fill="#3d2c00" fontFamily="monospace" fontWeight="bold">.py</text>
      </g>
      <g className="exp-file-hfss" transform="translate(290, 90)">
        <rect x="0" y="0" width="40" height="50" rx="2" fill="#06b6d4" stroke="#0891b2" />
        <text x="20" y="30" fontSize="9" textAnchor="middle" fill="#022c22" fontFamily="monospace" fontWeight="bold">.py</text>
      </g>
      <g className="exp-file-gds" transform="translate(340, 110)">
        <rect x="0" y="0" width="40" height="50" rx="2" fill="#a78bfa" stroke="#8b5cf6" />
        <text x="20" y="30" fontSize="9" textAnchor="middle" fill="#1e1b4b" fontFamily="monospace" fontWeight="bold">.gds</text>
      </g>
      <text x="200" y="188" fontSize="10" textAnchor="middle" fill="#64748b" fontFamily="monospace">
        pyAEDT · native HFSS COM · GDS-II — fully parametric where supported
      </text>
    </svg>
  );
}

// ── Steps registry ────────────────────────────────────────────────────
const STEPS = [
  {
    id: 'stack',
    title: 'Layer stack',
    blurb: 'The STACK panel defines the physical Z order of every layer: substrate, waveguide core, conductor metal(s), and cladding. Thicknesses are parameters so HFSS sweeps move the whole layout in lockstep.',
    Demo: StackDemo,
  },
  {
    id: 'draw',
    title: 'Drawing & layer selection',
    blurb: 'Pick a layer from the dropdown (waveguide green / conductor gold / port red), then drag on the canvas to create a shape. The active layer drives the shape\'s color, material, and exported Z position.',
    Demo: DrawingDemo,
  },
  {
    id: 'params',
    title: 'Parameters & scroll',
    blurb: 'Every dimension is an expression — w_wg, cap_d, feed_L… Edit them inline in the PARAMS panel or scroll-wheel directly on any value field (in PARAMS or the INSPECTOR) to retune. The canvas updates live.',
    Demo: ParamsDemo,
  },
  {
    id: 'snap',
    title: 'Snapping',
    blurb: 'Hold ⌥ (Option) while dragging — the closest pair of anchors (corners / edges / center) attracts the moving shape. Release to commit the snap, which becomes a parametric tie. The SNAPS panel lists every active snap; edit dx/dy as expressions to nudge the bond.',
    Demo: SnapDemo,
  },
  {
    id: 'ops',
    title: 'Operations',
    blurb: 'Multi-select + boolean (union / intersect / subtract / punch) merges shapes the HFSS way — the operands are consumed; the result is a derived component. Repeat / mirror / displace / rotate live in the transform chain per component.',
    Demo: OpsDemo,
  },
  {
    id: 'save',
    title: 'Saving — workspace · designs · versions',
    blurb: 'A workspace holds many designs, each with its own version history (snapshots). Save / Save-as for new designs; Snapshot to freeze the current state as v1 / v2 / … any time. The current "in-progress" row floats above the latest snapshot.',
    Demo: SaveDemo,
  },
  {
    id: 'lib',
    title: 'Library',
    blurb: 'Reusable snippets live in the LIBRARY panel — a GS pad, a coupling region, a feed taper. Add to library from any selection; insert from library into any design. Archived items are recoverable; deleted ones aren\'t.',
    Demo: LibraryDemo,
  },
  {
    id: 'dim',
    title: 'Dimensioning',
    blurb: 'Toggle the 📏 dimensions button to overlay every parameter-bound width, height, and snap offset on the canvas. Variable names show as the primary label; numeric values appear when there\'s room. Great for screenshotting a design for review.',
    Demo: DimensionDemo,
  },
  {
    id: 'export',
    title: 'Exporting',
    blurb: 'Export drops the design as a script: pyAEDT (modern Python API), native HFSS COM (IronPython 2.7 inside HFSS), or GDS-II for foundry tape-out. Parameters become HFSS variables — sweep them in HFSS without re-exporting.',
    Demo: ExportDemo,
  },
];

// CSS keyframes for every step. Stored in a single <style> block so the
// component is fully self-contained — no separate .css file to ship.
const TUTORIAL_KEYFRAMES = `
@keyframes tut-fade {
  0% { opacity: 0; } 20% { opacity: 1; } 90% { opacity: 1; } 100% { opacity: 0; }
}
@keyframes tut-slide-up {
  0% { opacity: 0; transform: translateY(20px); }
  100% { opacity: 1; transform: translateY(0); }
}

/* Step 2: layer pill cycles wg → elec → port */
@keyframes tut-pill-cycle {
  0%, 30%   { fill: #10b981; }
  33%, 63%  { fill: #daa520; }
  66%, 96%  { fill: #b91c1c; }
  100%      { fill: #10b981; }
}
@keyframes tut-draw-wg {
  0%, 4%  { width: 0; opacity: 0; }
  6%, 30% { width: 110px; opacity: 1; }
  31%, 100% { width: 110px; opacity: 1; }
}
@keyframes tut-draw-elec {
  0%, 34% { width: 0; opacity: 0; }
  36%, 63% { width: 130px; opacity: 1; }
  64%, 100% { width: 130px; opacity: 1; }
}
@keyframes tut-draw-port {
  0%, 67% { width: 0; opacity: 0; }
  69%, 96% { width: 80px; opacity: 1; }
  97%, 100% { width: 80px; opacity: 1; }
}
@keyframes tut-rect-label-wg { 0%, 5% { opacity: 0; } 12%, 100% { opacity: 1; } }
@keyframes tut-rect-label-elec { 0%, 35% { opacity: 0; } 42%, 100% { opacity: 1; } }
@keyframes tut-rect-label-port { 0%, 68% { opacity: 0; } 75%, 100% { opacity: 1; } }
@keyframes tut-cursor-1 {
  0%    { transform: translate(50px, 85px); }
  6%    { transform: translate(160px, 85px); }
  30%   { transform: translate(160px, 85px); }
  36%   { transform: translate(50px, 120px); }
  63%   { transform: translate(180px, 120px); }
  69%   { transform: translate(50px, 155px); }
  96%   { transform: translate(130px, 155px); }
  100%  { transform: translate(50px, 85px); }
}

/* Step 3: parameter scroll */
@keyframes tut-param-cycle {
  0%, 15% { fill: #fbbf24; }
  /* value visually swaps via content trick: keep color, but use a JS-free
     fake by overlaying labels. We just animate the geometry width. */
}
@keyframes tut-scroll-bounce {
  0%, 100% { transform: translate(290px, 49px); }
  20%      { transform: translate(290px, 43px); }
  40%      { transform: translate(290px, 55px); }
  60%      { transform: translate(290px, 47px); }
  80%      { transform: translate(290px, 53px); }
}
@keyframes tut-live-wg {
  0%, 100% { height: 20px; y: -10px; }
  25%      { height: 30px; y: -15px; }
  50%      { height: 14px; y: -7px; }
  75%      { height: 26px; y: -13px; }
}

/* Step 4: snap — cursor drags mover toward target */
@keyframes tut-snap-cursor {
  0%   { transform: translate(80px, 80px); }
  10%  { transform: translate(80px, 80px); }
  45%  { transform: translate(200px, 80px); }
  60%  { transform: translate(220px, 80px); }
  100% { transform: translate(220px, 80px); }
}
@keyframes tut-snap-mover {
  0%   { transform: translate(80px, 80px); }
  45%  { transform: translate(195px, 80px); }
  60%  { transform: translate(220px, 80px); }
  100% { transform: translate(220px, 80px); }
}
@keyframes tut-snap-target {
  0%, 100% { transform: translate(260px, 80px); }
}
@keyframes tut-snap-cross {
  0%, 25%  { opacity: 0; r: 4; }
  30%, 55% { opacity: 1; r: 7; }
  60%, 100% { opacity: 1; r: 4; }
}
@keyframes tut-snap-cross-b {
  0%, 25%  { opacity: 0; r: 4; }
  30%, 55% { opacity: 1; r: 7; }
  60%, 100% { opacity: 1; r: 4; }
}
@keyframes tut-opt-badge {
  0%, 15%  { opacity: 0; transform: translate(40px, 30px) scale(0.8); }
  20%, 70% { opacity: 1; transform: translate(40px, 30px) scale(1); }
  75%, 100% { opacity: 0; transform: translate(40px, 30px) scale(0.8); }
}
@keyframes tut-snap-link {
  0%, 55% { opacity: 0; x1: 0; y1: 0; x2: 0; y2: 0; }
  60%, 90% { opacity: 1; x1: 250px; y1: 80px; x2: 230px; y2: 80px; }
  91%, 100% { opacity: 0; }
}

/* Step 5: ops */
@keyframes tut-ops-cl {
  0%, 100% { cx: 80px; }
  35%, 75% { cx: 95px; }
}
@keyframes tut-ops-cr {
  0%, 100% { cx: 130px; }
  35%, 75% { cx: 115px; }
}
@keyframes tut-ops-glow {
  0%, 40% { opacity: 0; rx: 0; ry: 0; }
  45%, 80% { opacity: 1; rx: 50px; ry: 38px; }
  82%, 100% { opacity: 0; }
}
@keyframes tut-ops-rect-1 {
  0%, 100% { opacity: 1; }
}
@keyframes tut-ops-rect-2 {
  0%, 30% { opacity: 0; }
  35%, 100% { opacity: 1; }
}
@keyframes tut-ops-rect-3 {
  0%, 60% { opacity: 0; }
  65%, 100% { opacity: 1; }
}

/* Step 6: save */
@keyframes tut-save-icon {
  0%, 30%, 70%, 100% { transform: translate(60px, 160px) scale(1); }
  35%, 40%           { transform: translate(60px, 160px) scale(0.92); fill: #0891b2; }
  72%, 78%           { transform: translate(60px, 160px) scale(0.92); }
}
@keyframes tut-save-row-1 {
  0%, 20% { opacity: 0; }
  30%, 100% { opacity: 1; }
}
@keyframes tut-save-row-2 {
  0%, 70% { opacity: 0; }
  78%, 100% { opacity: 1; }
}
@keyframes tut-version-1 {
  0%, 40% { opacity: 0; }
  50%, 100% { opacity: 1; }
}
@keyframes tut-version-2 {
  0%, 55% { opacity: 0; }
  65%, 100% { opacity: 1; }
}
@keyframes tut-version-3 {
  0%, 75% { opacity: 0; }
  85%, 100% { opacity: 1; }
}

/* Step 7: library */
@keyframes tut-lib-shape {
  0%   { transform: translate(90px, 82px); opacity: 1; }
  25%  { transform: translate(90px, 82px); opacity: 1; }
  45%  { transform: translate(330px, 78px) scale(0.85); opacity: 1; }
  55%, 100% { transform: translate(330px, 78px) scale(0.85); opacity: 0; }
}
@keyframes tut-lib-icon {
  0%, 45% { opacity: 0; }
  55%, 100% { opacity: 1; }
}
@keyframes tut-lib-icon-text {
  0%, 50% { opacity: 0; }
  60%, 100% { opacity: 1; }
}
@keyframes tut-lib-cursor {
  0%   { transform: translate(90px, 90px); }
  25%  { transform: translate(90px, 80px); }
  45%  { transform: translate(330px, 75px); }
  60%  { transform: translate(330px, 85px); }
  75%  { transform: translate(90px, 175px); }
  100% { transform: translate(90px, 175px); }
}
@keyframes tut-lib-reuse {
  0%, 75% { opacity: 0; }
  85%, 100% { opacity: 1; }
}

/* Step 8: dim button glow */
@keyframes tut-dim-btn {
  0%, 20%  { filter: none; }
  25%, 100% { filter: drop-shadow(0 0 6px #a78bfa); }
}

/* Step 9: export */
@keyframes tut-exp-btn {
  0%, 20% { filter: none; }
  25%, 100% { filter: drop-shadow(0 0 6px #67e8f9); }
}
@keyframes tut-exp-menu {
  0%, 15% { opacity: 0; transform: translateY(-6px); }
  25%, 100% { opacity: 1; transform: translateY(0); }
}
@keyframes tut-exp-file {
  0% { opacity: 0; transform: translate(var(--start-x, 0), 0) rotate(-8deg); }
  30% { opacity: 1; }
  100% { opacity: 1; transform: translate(var(--end-x, 0), 24px) rotate(0deg); }
}
`;

// ── Main component ───────────────────────────────────────────────────
export function HelpTutorial({ open, onClose }) {
  const [step, setStep] = useState(0);
  // `tick` increments on every step change so the Demo component
  // re-mounts and its CSS animations restart from frame 0.
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
        style={{ background: '#0f172a', width: 'min(680px, 94vw)', height: 'min(560px, 90vh)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
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

        {/* Animated demo area */}
        <div className="flex-1 flex flex-col px-4 pt-3 pb-1 overflow-hidden">
          <div
            className="rounded border border-slate-800 overflow-hidden"
            style={{ background: '#020617', flex: '1 1 auto', minHeight: 0 }}
          >
            {/* `key` forces a fresh mount on each step change so animations
                restart. Doing it on the wrapper rather than the Demo lets
                React clean up the prior subtree first. */}
            <div key={`${step}-${tick}`} style={{ width: '100%', height: '100%' }}>
              <Demo />
            </div>
          </div>
          {/* Blurb */}
          <p className="text-xs text-slate-300 leading-relaxed mt-3 px-1">
            {s.blurb}
          </p>
        </div>

        {/* Footer: dot navigation + prev/next */}
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
