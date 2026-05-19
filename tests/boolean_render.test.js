// Regression: when a primitive operand of a boolean has its own transform
// chain (e.g. repeat n=3), all clones must contribute to the boolean's
// SVG mask AND the visible underlay. The previous bug: only the base
// instance ended up in the mask → A_1, A_2, A_3 silently disappeared.
//
// This test replicates the exact renderInterior pipeline (using the same
// helpers Canvas.jsx uses) and verifies the emitted SVG contains 4
// distinct paths for A's interior in both the mask AND the underlay.
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { solveLayout, applyMirrors, resolveBooleanBboxes } from '../src/scene/solver.js';
import { expandTransforms } from '../src/scene/transforms.js';
import { resolveParams, evalExpr } from '../src/scene/params.js';
import { shapeInstanceToRing } from '../src/geometry/rings.js';
import { ringToSvgPath } from '../src/geometry/paths.js';

describe('Boolean rendering with multi-instance operand', () => {
  it('emits one <path> per operand instance inside the mask + underlay', () => {
    const scene = {
      params: {},
      components: [
        {
          id: 'A', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: 20, h: 20,
          cutouts: [],
          transforms: [{ id: 't1', kind: 'repeat', enabled: true, n: 3, dx: 30, dy: 0, includeOriginal: true }],
          consumedBy: 'BOOL',
        },
        { id: 'B', kind: 'rect', layer: 'electrode', cx: 30, cy: 0, w: 10, h: 10, cutouts: [], transforms: [], consumedBy: 'BOOL' },
        { id: 'BOOL', kind: 'boolean', op: 'subtract', operandIds: ['A', 'B'], layer: 'electrode', cx: 0, cy: 0, w: '0', h: '0', cutouts: [], transforms: [] },
      ],
      snaps: [], mirrors: [],
    };
    const paramValues = resolveParams(scene.params).values;
    const solved = resolveBooleanBboxes(
      applyMirrors(solveLayout(scene.components, scene.snaps, paramValues), scene.mirrors),
      paramValues,
    );
    const transformInstances = expandTransforms(solved, paramValues);
    const instancesByCompId = {};
    for (const i of transformInstances) {
      if (!instancesByCompId[i.compId]) instancesByCompId[i.compId] = [];
      instancesByCompId[i.compId].push(i);
    }
    const compById = Object.fromEntries(scene.components.map(c => [c.id, c]));

    // Mirror the production helpers used by Canvas.jsx.
    let _defIdCounter = 0;
    const nextDefId = (prefix) => `${prefix}-${_defIdCounter++}`;
    const instancesOf = (c, overrides) => {
      if (overrides && overrides[c.id]) return [overrides[c.id]];
      const list = instancesByCompId[c.id];
      if (list && list.length > 0) return list;
      return [{ compId: c.id, idx: 0, cx: c.cx, cy: c.cy, w: evalExpr(c.w, paramValues), h: evalExpr(c.h, paramValues), rotation: 0 }];
    };
    const rectPathD = (inst) => ringToSvgPath(shapeInstanceToRing(inst));
    const collectBbox = (comp, overrides) => {
      const out = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
      const visit = (c) => {
        if (!c) return;
        if (c.kind === 'boolean') {
          for (const id of (c.operandIds || [])) visit(compById[id]);
        } else {
          for (const inst of instancesOf(c, overrides)) {
            for (const [x, y] of shapeInstanceToRing(inst)) {
              if (x < out.minX) out.minX = x; if (x > out.maxX) out.maxX = x;
              if (y < out.minY) out.minY = y; if (y > out.maxY) out.maxY = y;
            }
          }
        }
      };
      visit(comp);
      return out;
    };
    const renderInterior = (comp, fillColor, keyBase, dataCompId, parentClip, overrides) => {
      if (!comp) return null;
      if (comp.kind !== 'boolean') {
        const insts = instancesOf(comp, overrides);
        const pathProps = { fill: fillColor, ...(dataCompId ? { 'data-comp-id': dataCompId } : {}), ...(parentClip ? { clipPath: parentClip } : {}) };
        if (insts.length === 1) {
          return React.createElement('path', { key: keyBase, d: rectPathD(insts[0]), ...pathProps });
        }
        return React.createElement(React.Fragment, { key: keyBase },
          insts.map((inst, i) => React.createElement('path', { key: `${keyBase}-i${i}`, d: rectPathD(inst), ...pathProps }))
        );
      }
      const ops = (comp.operandIds || []).map(id => compById[id]).filter(Boolean);
      if (comp.op === 'subtract') {
        const maskId = nextDefId(`${keyBase}-submask`);
        const bbox = collectBbox(comp, overrides);
        const pad = Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY) * 0.1 + 1;
        const mvX = bbox.minX - pad, mvY = bbox.minY - pad;
        const mvW = (bbox.maxX - bbox.minX) + 2 * pad;
        const mvH = (bbox.maxY - bbox.minY) + 2 * pad;
        return React.createElement('g', { key: keyBase },
          React.createElement('defs', null,
            React.createElement('mask', { id: maskId, maskUnits: 'userSpaceOnUse', x: mvX, y: -mvY - mvH, width: mvW, height: mvH },
              React.createElement('rect', { x: mvX, y: -mvY - mvH, width: mvW, height: mvH, fill: 'black' }),
              renderInterior(ops[0], 'white', `${maskId}-base`, undefined, undefined, overrides),
              ops.slice(1).map((opC, i) => renderInterior(opC, 'black', `${maskId}-sub${i}`, undefined, undefined, overrides)),
            )
          ),
          React.createElement('g', { mask: `url(#${maskId})` },
            renderInterior(ops[0], fillColor, `${keyBase}-baseunder`, dataCompId, parentClip, overrides)
          )
        );
      }
      return null;
    };

    const out = renderInterior(compById.BOOL, '#daa520', 'bool-fill-BOOL-0', 'BOOL', undefined, null);
    const html = renderToStaticMarkup(out);
    // Mask should have 4 white <path>s (A's instances) and 1 black <path> (B).
    const whitePaths = (html.match(/<path[^>]*fill="white"/g) || []).length;
    const blackPaths = (html.match(/<path[^>]*fill="black"/g) || []).length;
    expect(whitePaths).toBe(4);
    expect(blackPaths).toBe(1);
    // Underlay should have 4 fill paths for A.
    const fillPaths = (html.match(/<path[^>]*fill="#daa520"/g) || []).length;
    expect(fillPaths).toBe(4);
    // Sanity: the 4 A instances are at x = -10..10, 20..40, 50..70, 80..100.
    expect(html).toContain('M -10 10');
    expect(html).toContain('M 20 10');
    expect(html).toContain('M 50 10');
    expect(html).toContain('M 80 10');
  });
});
