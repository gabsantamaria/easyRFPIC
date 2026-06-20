// Appearance themes.
//
// Two surfaces are themed:
//
//  1. CHROME (panels, header, dialogs, toolbars). These are Tailwind
//     `*-slate-*` utility classes plus a handful of var-ified inline styles.
//     The actual slate ramp lives in `src/index.css` as `--app-slate-*` CSS
//     variables: a `@theme inline` block remaps Tailwind's `--color-slate-*`
//     onto them, and `[data-theme="…"]` blocks override them per theme. So the
//     chrome recolors entirely in CSS — selecting a theme only sets the
//     `data-theme` attribute on <html> (see applyThemeAttr below). The ramps
//     are duplicated here ONLY for the SettingsPanel swatch previews.
//
//  2. CANVAS (the SVG: page background, grid, origin axes). These are painted
//     as string-literal hex on SVG attributes in Canvas.jsx, so they can't ride
//     the CSS remap — the resolved `canvas` object is threaded into <Canvas> as
//     the `canvasTheme` prop instead. Interaction-signal accents (snap amber,
//     halo cyan, dimension violet) are deliberately NOT themed — they're tuned
//     for contrast and read on any background.
//
// Adding a theme = add an entry here AND a matching `[data-theme]` block in
// src/index.css (chrome). The `canvas` object is the single source for the
// SVG surface colors.

// Canvas surface palette for the DEFAULT theme — also the fallback Canvas.jsx
// uses when no `canvasTheme` prop is passed (keeps existing render/tests
// byte-identical to the pre-theming behavior).
export const DEFAULT_CANVAS_THEME = {
  canvasBg: '#f1f5f9',  // Tailwind slate-100 — the original light canvas
  gridFine: '#cbd5e1',  // slate-300 — minor grid lines
  gridMajor: '#94a3b8', // slate-400 — major grid lines
  axis: '#475569',      // slate-600 — origin X/Y axes
};

export const THEMES = {
  default: {
    id: 'default',
    name: 'Slate',
    description: 'The original — dark slate panels, light canvas.',
    canvas: { ...DEFAULT_CANVAS_THEME },
    // Representative colors for the swatch preview card.
    swatch: { chrome: '#0f172a', panel: '#1e293b', canvas: '#f1f5f9', accent: '#06b6d4' },
  },
  midnight: {
    id: 'midnight',
    name: 'Midnight',
    description: 'Deep navy chrome with a dark canvas — easy on the eyes.',
    canvas: { canvasBg: '#0b1120', gridFine: '#1b2740', gridMajor: '#2c3a55', axis: '#5b6a86' },
    swatch: { chrome: '#0a1120', panel: '#111b2e', canvas: '#0b1120', accent: '#22d3ee' },
  },
  blueprint: {
    id: 'blueprint',
    name: 'Blueprint',
    description: 'Engineering blueprint — blue chrome, deep blue canvas.',
    canvas: { canvasBg: '#0a2540', gridFine: '#11406b', gridMajor: '#1d5a8f', axis: '#7fb2e0' },
    swatch: { chrome: '#0c2339', panel: '#143051', canvas: '#0a2540', accent: '#60a5fa' },
  },
  paper: {
    id: 'paper',
    name: 'Paper',
    description: 'Light everything — high-contrast for print and projectors.',
    canvas: { canvasBg: '#ffffff', gridFine: '#e5e7eb', gridMajor: '#cbd5e1', axis: '#94a3b8' },
    swatch: { chrome: '#f1f5f9', panel: '#ffffff', canvas: '#ffffff', accent: '#0891b2' },
  },
};

// Picker order (drives the SettingsPanel swatch row).
export const THEME_ORDER = ['default', 'midnight', 'blueprint', 'paper'];
export const DEFAULT_THEME_ID = 'default';

export function isThemeId(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(THEMES, id);
}

// Resolve a (possibly invalid) theme id to its definition, falling back to the
// default theme. Always returns a valid object.
export function resolveTheme(id) {
  return THEMES[isThemeId(id) ? id : DEFAULT_THEME_ID];
}

// The canvas palette for a theme id (what gets passed to <Canvas>).
export function resolveCanvasTheme(id) {
  return resolveTheme(id).canvas;
}

// Apply the chrome theme by setting the <html> data-theme attribute. The
// default theme uses :root (no attribute) so the attribute is removed for it.
// Pure DOM side effect; idempotent (safe under React.StrictMode double-invoke).
export function applyThemeAttr(id, doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d || !d.documentElement) return;
  const resolved = isThemeId(id) ? id : DEFAULT_THEME_ID;
  if (resolved === DEFAULT_THEME_ID) d.documentElement.removeAttribute('data-theme');
  else d.documentElement.setAttribute('data-theme', resolved);
}
