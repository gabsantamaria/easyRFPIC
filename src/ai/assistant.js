// AI geometry assistant — pure logic (no network).
//
// The user describes a structure in natural language and/or attaches a
// sketch image; Claude returns a SCENE FRAGMENT (params + components +
// snaps) through a forced-shape tool call. This module owns everything
// around that exchange that must stay deterministic and testable:
//
//   buildSystemPrompt(scene, prefix, paramValues)
//       — the app context handed to Claude: the component schema, the
//         snap/param conventions, the parametrize-everything rules, and
//         a summary of the CURRENT scene (existing params/components/
//         stack) so generated geometry can reference and snap to it.
//   GEOMETRY_TOOL
//       — the Anthropic tool definition whose input IS the fragment.
//   validateFragment(fragment, scene)
//       — structural + expression + snap-graph validation of Claude's
//         output BEFORE anything touches the scene. Returns
//         { errors, warnings }; a fragment with errors is never applied.
//   applyFragment(prev, fragment, { viewport, paramValues })
//       — merge the fragment into the scene (template-insert semantics:
//         fresh ids on collision, bbox centered on the viewport), then
//         normalizeScene so every expression field is string-coerced.
//   suggestPrefix(scene)
//       — next free `ai<N>` namespace; every id/param Claude creates is
//         required to carry it, which is what makes collisions rare and
//         the PARAMS panel grouping (`ai3_*`) automatic.
//
// The network call lives in src/ai/client.js; the dialog UI in
// src/ui/AiAssistantDialog.jsx.

import { resolveParams, evalExpr, tokenizeIdents, RESERVED_IDENTS } from '../scene/params.js';
import { solveLayout, validateSnapGraph } from '../scene/solver.js';
import { normalizeScene } from '../scene/schema.js';
import { ANCHORS } from '../scene/anchors.js';

export const FRAGMENT_KINDS = [
  'rect', 'circle', 'ellipse', 'polygon', 'racetrack', 'via', 'bridge', 'polyline', 'polyshape',
];

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---------------------------------------------------------------------------
// Prefix allocation
// ---------------------------------------------------------------------------

export function suggestPrefix(scene) {
  const taken = new Set();
  for (const c of scene.components || []) {
    const m = /^ai(\d+)_/.exec(c.id);
    if (m) taken.add(Number(m[1]));
  }
  for (const name of Object.keys(scene.params || {})) {
    const m = /^ai(\d+)_/.exec(name);
    if (m) taken.add(Number(m[1]));
  }
  let n = 1;
  while (taken.has(n)) n++;
  return `ai${n}`;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

// One-line summary of an existing component for the scene context block.
function describeComponent(c, paramValues) {
  const w = evalExpr(c.w, paramValues);
  const h = evalExpr(c.h, paramValues);
  const size = Number.isFinite(w) && Number.isFinite(h) ? ` size ${w.toFixed(1)}x${h.toFixed(1)}um` : '';
  const cons = c.consumedBy ? ` (consumed by boolean ${c.consumedBy})` : '';
  return `  - id "${c.id}": ${c.kind || 'rect'} on layer "${c.layer}" at (${Number(c.cx).toFixed(1)}, ${Number(c.cy).toFixed(1)})${size}${cons}`;
}

export function buildSystemPrompt(scene, prefix, paramValues = {}) {
  const conductors = (scene.stack || []).filter(l => l.role === 'conductor');
  const stackLines = (scene.stack || []).map(l =>
    `  - id "${l.id}" role ${l.role}: ${l.name || l.id} (thickness ${l.thickness})`).join('\n');
  const paramLines = Object.entries(scene.params || {}).slice(0, 120).map(([n, p]) =>
    `  - ${n} = ${p.expr}${p.desc ? `  (${p.desc})` : ''}`).join('\n');
  const compLines = (scene.components || []).slice(0, 120)
    .map(c => describeComponent(c, paramValues)).join('\n');

  return `You are the geometry engine of easyRFPIC, a parametric layout tool for RF/photonic integrated circuits (TFLN/TFLT modulators, CPWs, meanders, resonators). Layouts export to Ansys HFSS, where every parameter becomes an HFSS design variable for sweeps — so EVERYTHING you generate must be parametric. The user gives you a natural-language description and/or a sketch image; you respond by calling the emit_geometry tool exactly once with a scene fragment.

## Coordinate system and units
- All lengths are micrometres (um). The world is y-UP (+y is "north"/up, like physics, unlike SVG).
- Positions cx/cy are NUMBERS (um). All dimension fields are EXPRESSION STRINGS that may reference parameters, e.g. "cpw_w_sig" or "2*r_ring + 5".
- Center your fragment roughly on (0, 0); the app re-centers it at the user's viewport automatically.

## Output contract (emit_geometry input)
{
  "params":     [ { "name", "expr", "unit"?, "desc"? } ... ],
  "components": [ ... see schema below ... ],
  "snaps":      [ { "from": {"compId","anchor"}, "to": {"compId","anchor"}, "dx", "dy" } ... ],
  "notes":      "one short sentence for the user (optional)"
}

## NAMESPACE RULE (mandatory)
Every NEW component id and every NEW parameter name MUST start with "${prefix}_". Example: "${prefix}_w_sig", "${prefix}_sig", "${prefix}_gnd_top". Existing scene ids/params (listed below) are referenced WITHOUT any prefix change.

## Component schema
Common fields: { id, kind, layer, cx (number), cy (number), w, h }.
- layer is one of: "electrode" (metal/conductor), "waveguide" (optical), "port" (lumped-port rectangle; must be a rect spanning a gap between two electrodes). Electrode/port components MAY carry "conductorLayerId" = a conductor stack-layer id (see stack below) to bind to a specific metal; omit to use the default (topmost) conductor.
- Per kind:
  - "rect":      w, h (expression strings). Optional cornerRadius (fillet, expr).
  - "circle":    r (expr). Set w = "2*(r expr)", h likewise.
  - "ellipse":   rx, ry (exprs). w = "2*(rx)", h = "2*(ry)".
  - "polygon":   r, n (exprs; regular n-gon, apex up). w = h = "2*(r)".
  - "racetrack": R, L_straight, p, wgWidth (exprs; hollow waveguide band racetrack resonator). Use on layer "waveguide".
  - "via":       r (expr), layerFrom, layerTo (stack-layer ids); layer MUST be "via". Vertical cylinder connecting two stack layers.
  - "bridge":    length, width, height (exprs); layer MUST be "bridge". An RF AIRBRIDGE: a conductor strap that takes off at the conductor layer's TOP, arcs UP to an apex \`height\` above it, and lands back down \`length\` away; plan-view footprint = length x width (w = "(length)", h = "(width)"). Optional: thickness (expr; empty/omitted = the conductor layer's thickness), conductorLayerId (which conductor it takes off from), rotation (deg CCW — the strap spans the local X axis at rotation 0). Use it to jump one electrode OVER another (ground straps across a CPW, crossovers). Bridges canNOT be boolean operands and have no zOffset/cornerRadius.
  - "polyline":  width (expr), vertices (array, >= 2), closed (bool, usually false). A constant- or tapered-width trace. w = "0", h = "0".
  - "polyshape": vertices (array, >= 3), closed: true. A filled 2-D polygon path. w = "0", h = "0".
- Optional on rect/circle/ellipse/polygon: "rotation" (degrees CCW, expr string), "zOffset" (um expr, Z shift vs layer).
- Vertices (polyline/polyshape) — each one of:
  - { "kind": "rel", "dx": expr, "dy": expr }            step from the previous vertex (first vertex steps from (cx, cy)).
  - { "kind": "snap", "compId", "anchor" }                pinned to another component's anchor.
  - { "kind": "arc", "cdx": expr, "cdy": expr, "angle": expr }  circular arc; center = prev + (cdx, cdy); sweeps angle degrees CCW (negative = CW); the vertex is the arc ENDPOINT.
  - A rel vertex may add "spline": true (consecutive spline vertices form one smooth NURBS run) and polyline rel/snap vertices may add "width": expr for tapers.
- Optional "transforms" array per component, applied in order AFTER snapping:
  - { "kind": "repeat", "enabled": true, "n": <count expr>, "dx": expr, "dy": expr, "includeOriginal": true }  — N extra copies stepped by (dx, dy). USE THIS for periodic structures (IDC fingers, electrode arrays).
  - { "kind": "displace", "enabled": true, "dx": expr, "dy": expr }
  - { "kind": "rotate", "enabled": true, "angle": expr, "pivot": "C" }
- Do NOT emit kind "boolean", cutouts, or groups — the user applies boolean operations afterwards in the app.

## Snaps — THE way to position things (critical)
A snap pins a CHILD component to a PARENT: child anchor position = parent anchor position + (dx, dy). Anchors are the 9-point grid: ${ANCHORS.join(', ')} (N = +y/top, E = +x/right). dx/dy are EXPRESSION STRINGS.
- "from" = the PARENT (reference), "to" = the CHILD (the component that moves).
- Each component may be the "to" (child) of AT MOST ONE snap. Chains are encouraged: A <- B <- C.
- Position components with snaps + parametric dx/dy, NOT by baking numbers into cx/cy. Give the ROOT component a numeric cx/cy (e.g. 0, 0) and hang everything else off it with snaps, so changing one parameter (a gap, a width) moves the whole structure consistently in both the canvas and HFSS.
- Example (CPW): ground_top snapped to signal: from {compId: "${prefix}_sig", anchor: "N"}, to {compId: "${prefix}_gnd_top", anchor: "S"}, dx: "0", dy: "${prefix}_gap" — sweeping ${prefix}_gap in HFSS then moves the ground parametrically.
- You may snap new components to EXISTING scene components by their listed ids.

## Design rules
1. Parametrize every meaningful dimension as a param with a descriptive name, unit "um" (or "" for counts/ratios), and a short desc. Derived dimensions reference other params in their expr.
2. Widths/heights/dimensions: expression strings referencing your params. Never hardcode a number that an engineer would want to sweep.
3. RF sanity: keep metal on "electrode", optics on "waveguide". A lumped-port rect ("port" layer) must exactly span the gap between two electrode edges (use snaps so it stays glued when the gap sweeps).
4. If the request is ambiguous or the sketch is unreadable, DO NOT guess silently — reply in plain text with ONE concise clarifying question instead of calling the tool.
5. Keep fragments focused: generate what was asked, nothing decorative.

## Current layer stack (bottom-up)
${stackLines || '  (default stack)'}
Conductor layer ids usable as conductorLayerId / via layerFrom/layerTo: ${conductors.map(l => `"${l.id}"`).join(', ') || '(none)'}.

## Existing scene parameters
${paramLines || '  (none)'}

## Existing scene components (snap targets)
${compLines || '  (none — empty canvas)'}
`;
}

// ---------------------------------------------------------------------------
// Tool definition (the fragment IS the tool input)
// ---------------------------------------------------------------------------

const EXPR = { type: 'string', description: 'Expression string in um; may reference param names.' };

export const GEOMETRY_TOOL = {
  name: 'emit_geometry',
  description: 'Emit the generated parametric scene fragment. Call this exactly once when the requested geometry is unambiguous. All new ids/param names must carry the required prefix. If you instead need clarification from the user, reply in plain text WITHOUT calling this tool.',
  input_schema: {
    type: 'object',
    properties: {
      params: {
        type: 'array',
        description: 'New parameters (the sweep knobs of this fragment).',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            expr: { type: 'string', description: 'Default value or expression referencing other params.' },
            unit: { type: 'string', description: '"um" for lengths, "" for counts/ratios/degrees.' },
            desc: { type: 'string' },
          },
          required: ['name', 'expr'],
        },
      },
      components: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            kind: { type: 'string', enum: FRAGMENT_KINDS },
            layer: { type: 'string', enum: ['electrode', 'waveguide', 'port', 'via', 'bridge'] },
            cx: { type: 'number' },
            cy: { type: 'number' },
            w: EXPR, h: EXPR, r: EXPR, rx: EXPR, ry: EXPR, n: EXPR,
            R: EXPR, L_straight: EXPR, p: EXPR, wgWidth: EXPR,
            length: EXPR, height: EXPR, thickness: EXPR,
            width: EXPR, closed: { type: 'boolean' },
            vertices: { type: 'array', items: { type: 'object' } },
            rotation: EXPR, zOffset: EXPR, cornerRadius: EXPR,
            conductorLayerId: { type: 'string' },
            layerFrom: { type: 'string' }, layerTo: { type: 'string' },
            transforms: { type: 'array', items: { type: 'object' } },
          },
          required: ['id', 'kind', 'layer', 'cx', 'cy'],
        },
      },
      snaps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            from: {
              type: 'object',
              properties: { compId: { type: 'string' }, anchor: { type: 'string', enum: ANCHORS } },
              required: ['compId', 'anchor'],
            },
            to: {
              type: 'object',
              properties: { compId: { type: 'string' }, anchor: { type: 'string', enum: ANCHORS } },
              required: ['compId', 'anchor'],
            },
            dx: EXPR, dy: EXPR,
          },
          required: ['from', 'to', 'dx', 'dy'],
        },
      },
      notes: { type: 'string' },
    },
    required: ['components'],
  },
};

// ---------------------------------------------------------------------------
// Fragment validation
// ---------------------------------------------------------------------------

const KIND_REQUIRED = {
  rect: ['w', 'h'],
  circle: ['r'],
  ellipse: ['rx', 'ry'],
  polygon: ['r', 'n'],
  racetrack: ['R', 'L_straight', 'p', 'wgWidth'],
  via: ['r'],
  bridge: ['length', 'width', 'height'],
  polyline: ['width', 'vertices'],
  polyshape: ['vertices'],
};

// Coerce a maybe-numeric expression field to a string (Claude sometimes
// emits numbers despite the schema saying string — harmless, fix it).
const asExpr = (v) => (v == null ? v : String(v));

// Normalize a raw fragment in place-ish (returns a deep-adjusted copy):
// expression fields → strings, missing derived w/h filled per kind,
// defaults for cutouts/transforms. Validation runs on the normalized form.
export function normalizeFragment(fragment) {
  const params = (fragment.params || []).map(p => ({
    name: String(p.name || ''),
    expr: asExpr(p.expr ?? '0'),
    unit: p.unit != null ? String(p.unit) : 'um',
    desc: p.desc != null ? String(p.desc) : '',
  }));
  const components = (fragment.components || []).map(raw => {
    const c = { ...raw };
    for (const f of ['w', 'h', 'r', 'rx', 'ry', 'n', 'R', 'L_straight', 'p', 'wgWidth',
      'width', 'length', 'height', 'thickness', 'rotation', 'zOffset', 'cornerRadius']) {
      if (c[f] != null) c[f] = asExpr(c[f]);
    }
    c.cx = Number(c.cx) || 0;
    c.cy = Number(c.cy) || 0;
    // Derived AABBs per the app convention.
    if (c.kind === 'circle' && c.r != null) { c.w = `2*(${c.r})`; c.h = `2*(${c.r})`; }
    if (c.kind === 'via' && c.r != null) { c.layer = 'via'; c.w = `2*(${c.r})`; c.h = `2*(${c.r})`; }
    if (c.kind === 'bridge') {
      c.layer = 'bridge';
      if (c.length != null) c.w = `(${c.length})`;
      if (c.width != null) c.h = `(${c.width})`;
    }
    if (c.kind === 'ellipse') { if (c.rx != null) c.w = `2*(${c.rx})`; if (c.ry != null) c.h = `2*(${c.ry})`; }
    if (c.kind === 'polygon' && c.r != null) { c.w = `2*(${c.r})`; c.h = `2*(${c.r})`; }
    if (c.kind === 'polyline' || c.kind === 'polyshape') {
      c.w = '0'; c.h = '0';
      if (c.kind === 'polyshape') c.closed = true;
      c.vertices = (c.vertices || []).map(v => {
        const nv = { ...v };
        if (nv.kind == null && nv.dx != null) nv.kind = 'rel';
        for (const f of ['dx', 'dy', 'cdx', 'cdy', 'angle', 'width']) {
          if (nv[f] != null) nv[f] = asExpr(nv[f]);
        }
        if ('spline' in nv) nv.spline = !!nv.spline;
        return nv;
      });
    }
    if (!Array.isArray(c.cutouts)) c.cutouts = [];
    c.transforms = (c.transforms || []).map(t => ({
      enabled: true,
      ...t,
      ...(t.kind === 'repeat' && t.includeOriginal == null ? { includeOriginal: true } : {}),
    }));
    return c;
  });
  const snaps = (fragment.snaps || []).map(s => ({
    from: { compId: String(s.from?.compId ?? ''), anchor: String(s.from?.anchor ?? 'C') },
    to: { compId: String(s.to?.compId ?? ''), anchor: String(s.to?.anchor ?? 'C') },
    dx: asExpr(s.dx ?? '0'),
    dy: asExpr(s.dy ?? '0'),
  }));
  return { params, components, snaps, notes: fragment.notes ? String(fragment.notes) : '' };
}

const TRANSFORM_KINDS = new Set(['displace', 'rotate', 'repeat', 'duplicate_mirror']);

// Validate a NORMALIZED fragment against the destination scene.
// Returns { errors: string[], warnings: string[] } — errors block insert.
export function validateFragment(fragment, scene) {
  const errors = [];
  const warnings = [];
  const f = fragment;

  if (!Array.isArray(f.components) || f.components.length === 0) {
    return { errors: ['Fragment contains no components.'], warnings };
  }

  // --- params -------------------------------------------------------------
  const sceneParamNames = new Set(Object.keys(scene.params || {}));
  const fragParamNames = new Set();
  for (const p of f.params) {
    if (!IDENT_RE.test(p.name)) errors.push(`Param name "${p.name}" is not a valid identifier.`);
    else if (fragParamNames.has(p.name)) errors.push(`Duplicate param name "${p.name}" in fragment.`);
    else if (sceneParamNames.has(p.name)) warnings.push(`Param "${p.name}" already exists in the scene — the existing definition is kept.`);
    fragParamNames.add(p.name);
  }

  // Merged param values for expression checks (scene wins on collision,
  // matching applyFragment / insertLibraryPayload semantics).
  const mergedParams = { ...Object.fromEntries(f.params.map(p => [p.name, { expr: p.expr, unit: p.unit, desc: p.desc }])), ...(scene.params || {}) };
  const { values } = resolveParams(mergedParams);
  for (const p of f.params) {
    if (!Number.isFinite(values[p.name])) {
      errors.push(`Param "${p.name}" = "${p.expr}" does not evaluate to a finite number.`);
    }
  }

  // --- components ----------------------------------------------------------
  const sceneIds = new Set((scene.components || []).map(c => c.id));
  const fragIds = new Set();
  // evalExpr deliberately falls back to 0 on broken input (the canvas
  // must never crash on a half-typed expression), so "does it evaluate"
  // is checked here as "every identifier resolves": a param in the
  // merged set, a math builtin, or a synthetic _comp_* position param.
  const unknownIdents = (expr) => tokenizeIdents(expr).filter(
    id => !(id in values) && !RESERVED_IDENTS.has(id) && !id.startsWith('_comp_'),
  );
  const checkExpr = (cid, field, expr) => {
    const unknown = unknownIdents(expr);
    if (unknown.length > 0) {
      errors.push(`Component "${cid}" field ${field} = "${expr}" references unknown parameter(s) ${unknown.join(', ')} — it does not evaluate.`);
      return;
    }
    const v = evalExpr(expr, values);
    if (!Number.isFinite(v)) errors.push(`Component "${cid}" field ${field} = "${expr}" does not evaluate.`);
  };
  for (const c of f.components) {
    if (!IDENT_RE.test(c.id || '')) { errors.push(`Component id "${c.id}" is not a valid identifier.`); continue; }
    if (fragIds.has(c.id)) { errors.push(`Duplicate component id "${c.id}" in fragment.`); continue; }
    fragIds.add(c.id);
    if (sceneIds.has(c.id)) warnings.push(`Component id "${c.id}" already exists — it will be renamed on insert.`);
    if (!FRAGMENT_KINDS.includes(c.kind)) { errors.push(`Component "${c.id}" has unknown kind "${c.kind}".`); continue; }
    if (!['electrode', 'waveguide', 'port', 'via', 'bridge'].includes(c.layer)) {
      errors.push(`Component "${c.id}" has invalid layer "${c.layer}".`);
    }
    for (const field of KIND_REQUIRED[c.kind] || []) {
      if (c[field] == null) errors.push(`Component "${c.id}" (${c.kind}) is missing required field "${field}".`);
    }
    for (const field of ['w', 'h', 'r', 'rx', 'ry', 'n', 'R', 'L_straight', 'p', 'wgWidth', 'width', 'length', 'height', 'thickness', 'rotation', 'zOffset', 'cornerRadius']) {
      if (typeof c[field] === 'string' && !(c.kind === 'bridge' && field === 'thickness' && c[field].trim() === '')) checkExpr(c.id, field, c[field]);
    }
    if (c.kind === 'polyline' || c.kind === 'polyshape') {
      const minV = c.kind === 'polyshape' ? 3 : 2;
      if (!Array.isArray(c.vertices) || c.vertices.length < minV) {
        errors.push(`Component "${c.id}" (${c.kind}) needs at least ${minV} vertices.`);
      } else {
        c.vertices.forEach((v, i) => {
          const k = v.kind || 'rel';
          if (k === 'rel') {
            if (v.dx == null || v.dy == null) errors.push(`"${c.id}" vertex ${i}: rel vertex needs dx and dy.`);
            else { checkExpr(c.id, `vertex[${i}].dx`, v.dx); checkExpr(c.id, `vertex[${i}].dy`, v.dy); }
          } else if (k === 'arc') {
            for (const fld of ['cdx', 'cdy', 'angle']) {
              if (v[fld] == null) errors.push(`"${c.id}" vertex ${i}: arc vertex needs ${fld}.`);
              else checkExpr(c.id, `vertex[${i}].${fld}`, v[fld]);
            }
          } else if (k === 'snap') {
            if (!v.compId || !(fragIds.has(v.compId) || sceneIds.has(v.compId))) {
              errors.push(`"${c.id}" vertex ${i}: snap vertex references unknown component "${v.compId}".`);
            }
            if (v.anchor && !ANCHORS.includes(v.anchor)) errors.push(`"${c.id}" vertex ${i}: invalid anchor "${v.anchor}".`);
          } else {
            errors.push(`"${c.id}" vertex ${i}: unknown vertex kind "${k}".`);
          }
        });
      }
    }
    if (c.kind === 'via') {
      const layerIds = new Set((scene.stack || []).map(l => l.id));
      for (const fld of ['layerFrom', 'layerTo']) {
        if (c[fld] && !layerIds.has(c[fld])) {
          warnings.push(`Via "${c.id}" ${fld} "${c[fld]}" is not a stack layer id — the app default will be used.`);
        }
      }
    }
    if (c.conductorLayerId) {
      const conductorIds = new Set((scene.stack || []).filter(l => l.role === 'conductor').map(l => l.id));
      if (!conductorIds.has(c.conductorLayerId)) {
        warnings.push(`Component "${c.id}" conductorLayerId "${c.conductorLayerId}" is not a conductor layer — the default conductor will be used.`);
      }
    }
    for (const t of c.transforms || []) {
      if (!TRANSFORM_KINDS.has(t.kind)) { errors.push(`Component "${c.id}" has unknown transform kind "${t.kind}".`); continue; }
      const fields = t.kind === 'repeat' ? ['n', 'dx', 'dy']
        : t.kind === 'displace' ? ['dx', 'dy']
        : t.kind === 'rotate' ? ['angle']
        : ['offset'];
      for (const fld of fields) {
        if (t[fld] == null) errors.push(`Component "${c.id}" ${t.kind} transform is missing "${fld}".`);
        else if (typeof t[fld] === 'string') checkExpr(c.id, `transform.${fld}`, t[fld]);
      }
    }
  }

  // --- snaps ----------------------------------------------------------------
  const allIds = new Set([...sceneIds, ...fragIds]);
  const snapTargets = new Set((scene.snaps || []).map(s => s.to?.compId));
  for (const s of f.snaps) {
    for (const side of ['from', 'to']) {
      if (!allIds.has(s[side].compId)) errors.push(`Snap ${side} references unknown component "${s[side].compId}".`);
      if (!ANCHORS.includes(s[side].anchor)) errors.push(`Snap anchor "${s[side].anchor}" is invalid.`);
    }
    if (sceneIds.has(s.to.compId) && !fragIds.has(s.to.compId)) {
      errors.push(`Snap targets EXISTING component "${s.to.compId}" as its child — new snaps may only position NEW components.`);
    }
    if (snapTargets.has(s.to.compId)) errors.push(`Component "${s.to.compId}" is the child of more than one snap.`);
    snapTargets.add(s.to.compId);
    for (const fld of ['dx', 'dy']) {
      const unknown = unknownIdents(s[fld]);
      if (unknown.length > 0) {
        errors.push(`Snap onto "${s.to.compId}" ${fld} = "${s[fld]}" references unknown parameter(s) ${unknown.join(', ')}.`);
      } else if (!Number.isFinite(evalExpr(s[fld], values))) {
        errors.push(`Snap onto "${s.to.compId}" has non-evaluating ${fld} = "${s[fld]}".`);
      }
    }
  }

  // --- trial solve -----------------------------------------------------------
  if (errors.length === 0) {
    try {
      const merged = [...(scene.components || []), ...f.components];
      const mergedSnaps = [...(scene.snaps || []), ...f.snaps];
      const graphIssues = validateSnapGraph(merged, mergedSnaps);
      for (const issue of graphIssues || []) {
        errors.push(`Snap graph: ${issue.message || issue.type || JSON.stringify(issue)}`);
      }
      if (errors.length === 0) solveLayout(merged, mergedSnaps, values);
    } catch (e) {
      errors.push(`Trial solve failed: ${e.message}`);
    }
  }

  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Fragment application (template-insert semantics)
// ---------------------------------------------------------------------------

export function applyFragment(prev, rawFragment, ctx = {}) {
  const fragment = normalizeFragment(rawFragment);
  const viewport = ctx.viewport || { x: 0, y: 0 };
  const paramValues = ctx.paramValues || {};

  // Params: add fragment params that don't already exist (scene wins —
  // matches insertLibraryPayload "global param" semantics; the prefix
  // rule makes collisions a non-event in practice).
  const newParams = { ...prev.params };
  for (const p of fragment.params) {
    if (!newParams[p.name]) newParams[p.name] = { expr: p.expr, unit: p.unit || 'um', desc: p.desc || '' };
  }

  // Ids: collision-avoid against the scene (defensive; the prefix should
  // already guarantee uniqueness).
  const idMap = {};
  const usedIds = new Set((prev.components || []).map(c => c.id));
  for (const c of fragment.components) {
    let id = c.id;
    let i = 2;
    while (usedIds.has(id)) id = `${c.id}_${i++}`;
    usedIds.add(id);
    idMap[c.id] = id;
  }

  // Center the fragment bbox on the viewport.
  const { values } = resolveParams(newParams, paramValues);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of fragment.components) {
    const w = evalExpr(c.w, values) || 10;
    const h = evalExpr(c.h, values) || 10;
    minX = Math.min(minX, c.cx - w / 2); maxX = Math.max(maxX, c.cx + w / 2);
    minY = Math.min(minY, c.cy - h / 2); maxY = Math.max(maxY, c.cy + h / 2);
  }
  const dx = Number.isFinite(minX) ? viewport.x - (minX + maxX) / 2 : 0;
  const dy = Number.isFinite(minY) ? viewport.y - (minY + maxY) / 2 : 0;

  const newComponents = [
    ...prev.components,
    ...fragment.components.map(c => ({
      ...c,
      id: idMap[c.id],
      cx: c.cx + dx,
      cy: c.cy + dy,
      vertices: c.vertices
        ? c.vertices.map(v => (v.kind === 'snap' && idMap[v.compId] ? { ...v, compId: idMap[v.compId] } : v))
        : c.vertices,
    })),
  ];

  const ts = Date.now();
  const newSnaps = [
    ...prev.snaps,
    ...fragment.snaps.map((s, i) => ({
      id: `snap_${ts}_ai${i}_${Math.random().toString(36).slice(2, 6)}`,
      from: { ...s.from, compId: idMap[s.from.compId] || s.from.compId },
      to: { ...s.to, compId: idMap[s.to.compId] || s.to.compId },
      dx: s.dx, dy: s.dy,
    })),
  ];

  // normalizeScene string-coerces every expression field and fills via /
  // vertex defaults exactly like a loaded design, so the AI path can never
  // smuggle a non-normalized component shape into the app.
  return normalizeScene({
    ...prev,
    params: newParams,
    components: newComponents,
    snaps: newSnaps,
  });
}
