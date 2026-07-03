// CrossSectionPreview — pure presentational SVG of a CROSS-SECTION CONTRACT
// object (buildCrossSection output). No state, no effects — the parent owns
// the cross + role map; this just draws.
//
// Vertical scale is NON-UNIFORM on purpose: a 50 µm Si substrate + 16 µm of
// air would crush a 0.6 µm LN film + 0.8 µm metal to invisibility under a
// linear map. The DEVICE band (min conductor/wg z0 − 2 µm … max z1 + 2 µm)
// gets ~70% of the vertical pixels; the far substrate below and air above
// share the remainder proportionally, via a piecewise-linear z→pixel map.
// Break marks (double slanted ticks at the left edge) flag where compression
// starts, so the picture can't silently lie about the substrate thickness.
//
// All colors come from the cross data (layer colors travel with the slice) —
// only the chrome (axes, labels, crosshair, badges) uses fixed accents.

const PAD_L = 42;  // z-axis tick labels
const PAD_R = 8;
const PAD_T = 10;  // room for a role badge above a top-row conductor
const PAD_B = 18;  // t-axis tick labels

// 1-2-5 step so t-axis ticks land on round µm values.
function niceStep(span, target) {
  const raw = span / Math.max(target, 1);
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-12))));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

// Compact numeric label: 2 decimals, trailing zeros stripped.
const fmt = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return String(Math.abs(n) >= 100 ? Math.round(n) : +n.toFixed(2));
};

export function CrossSectionPreview({ cross, roles = {}, width = 560, height = 280, highlightWgCenter = true }) {
  if (!cross || !cross.ok) return null; // the parent surfaces cross.error

  const dom = cross.domain || {};
  const slabs = Array.isArray(cross.slabs) ? cross.slabs : [];
  const conductors = Array.isArray(cross.conductors) ? cross.conductors : [];
  const waveguides = Array.isArray(cross.waveguides) ? cross.waveguides : [];

  const tMin = Number.isFinite(dom.tMin) ? dom.tMin : 0;
  const tMax = Number.isFinite(dom.tMax) && dom.tMax > tMin ? dom.tMax : tMin + 1;
  const zMin = Number.isFinite(dom.zMin) ? dom.zMin : 0;
  const zMax = Number.isFinite(dom.zMax) && dom.zMax > zMin ? dom.zMax : zMin + 1;

  const x0 = PAD_L, x1 = width - PAD_R;
  const yTop = PAD_T, yBot = height - PAD_B;
  const tToX = (t) => x0 + ((t - tMin) / (tMax - tMin)) * (x1 - x0);

  // Device band = everything the eye cares about: conductors + wg slab/core,
  // padded 2 µm, clamped into the domain. No conductors/wg → uniform map.
  let devLo = Infinity, devHi = -Infinity;
  for (const c of conductors) {
    if (Number.isFinite(c.z0)) devLo = Math.min(devLo, c.z0);
    if (Number.isFinite(c.z1)) devHi = Math.max(devHi, c.z1);
  }
  for (const w of waveguides) {
    if (w.slabBand) { devLo = Math.min(devLo, w.slabBand.z0); devHi = Math.max(devHi, w.slabBand.z1); }
    if (w.core) { devLo = Math.min(devLo, w.core.zBot); devHi = Math.max(devHi, w.core.zTop); }
  }
  if (!Number.isFinite(devLo) || !Number.isFinite(devHi) || devHi <= devLo) { devLo = zMin; devHi = zMax; }
  devLo = Math.max(zMin, devLo - 2);
  devHi = Math.min(zMax, devHi + 2);

  // Pixel budget: device ≈70%; below/above split the rest proportional to
  // their µm spans (a missing region donates its share back to the device).
  const totalPx = yBot - yTop;
  const belowSpan = Math.max(0, devLo - zMin);
  const aboveSpan = Math.max(0, zMax - devHi);
  const outerSpan = belowSpan + aboveSpan;
  const outerPx = outerSpan > 0 ? 0.3 * totalPx : 0;
  const belowPx = outerSpan > 0 ? outerPx * (belowSpan / outerSpan) : 0;
  const abovePx = outerPx - belowPx;
  // Piecewise-linear breakpoints, bottom→top in z, top→bottom in SVG y.
  const zs = [zMin, devLo, devHi, zMax];
  const ys = [yBot, yBot - belowPx, yTop + abovePx, yTop];
  const zToY = (z) => {
    const zc = Math.min(zMax, Math.max(zMin, z));
    for (let i = 0; i < 3; i++) {
      if (zc <= zs[i + 1] || i === 2) {
        const seg = zs[i + 1] - zs[i];
        const f = seg > 1e-9 ? (zc - zs[i]) / seg : 0;
        return ys[i] + f * (ys[i + 1] - ys[i]);
      }
    }
    return yTop;
  };

  // Break marks only where the outer region really is compressed (µm/px
  // density < half the device's) — an uncompressed map gets no scare glyphs.
  const pxPerUmDev = (totalPx - belowPx - abovePx) / Math.max(devHi - devLo, 1e-9);
  const breakBelow = belowSpan > 0.5 && (belowPx / belowSpan) < 0.5 * pxPerUmDev;
  const breakAbove = aboveSpan > 0.5 && (abovePx / aboveSpan) < 0.5 * pxPerUmDev;

  // Signal numbering (S1/S2/…) in conductor order; grounds are all 'G'.
  const sigIds = conductors.filter((c) => roles[c.id] !== 'ground').map((c) => c.id);

  // z tick labels at slab boundaries (the physically meaningful heights),
  // deduped and thinned so compressed regions can't overlap labels.
  const zTickVals = [];
  for (const s of slabs) { zTickVals.push(s.z0, s.z1); }
  if (zTickVals.length === 0) zTickVals.push(zMin, zMax);
  const zTicks = [];
  for (const z of [...new Set(zTickVals.map((v) => +Number(v).toFixed(4)))].sort((a, b) => a - b)) {
    const y = zToY(z);
    if (zTicks.length === 0 || Math.abs(y - zTicks[zTicks.length - 1].y) >= 10) zTicks.push({ z, y });
  }

  // t ticks on a nice grid.
  const tStep = niceStep(tMax - tMin, 6);
  const tTicks = [];
  for (let t = Math.ceil(tMin / tStep) * tStep; t <= tMax + 1e-9; t += tStep) tTicks.push(t);

  const breakMark = (y, key) => (
    // Axis-break glyph: two short parallel slanted strokes across the z axis.
    <g key={key} stroke="#64748b" strokeWidth="1">
      <line x1={x0 - 5} y1={y + 2.5} x2={x0 + 5} y2={y - 2.5} />
      <line x1={x0 - 5} y1={y + 5.5} x2={x0 + 5} y2={y + 0.5} />
    </g>
  );

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" style={{ display: 'block', maxWidth: width }}>
      {/* background slabs, bottom→top (substrate, oxide, film, cladding, air) */}
      {slabs.map((s) => {
        const yA = zToY(s.z1), yB = zToY(s.z0);
        const h = Math.max(yB - yA, 0.5);
        return (
          <g key={s.layerId}>
            <rect x={x0} y={yA} width={x1 - x0} height={h} fill={s.color || '#334155'} opacity={0.35} />
            <line x1={x0} y1={yB} x2={x1} y2={yB} stroke={s.color || '#334155'} strokeWidth="0.5" opacity={0.6} />
            {h >= 9 && (
              <text x={x0 + 4} y={yA + h / 2 + 3} fontSize="8" fill="#94a3b8">{s.name}</text>
            )}
          </g>
        );
      })}

      {/* waveguides: partially-etched slab band + etch-angle core trapezoid */}
      {waveguides.map((w) => (
        <g key={w.id}>
          {w.slabBand && (w.slabBand.intervals || []).map((iv, i) => (
            <rect key={i} x={tToX(iv.t0)} y={zToY(w.slabBand.z1)}
              width={Math.max(tToX(iv.t1) - tToX(iv.t0), 0.5)}
              height={Math.max(zToY(w.slabBand.z0) - zToY(w.slabBand.z1), 0.5)}
              fill={w.color || '#7dd3fc'} opacity={0.5} />
          ))}
          {w.core && (w.core.segments || []).map((sg, i) => (
            <polygon key={i}
              points={`${tToX(sg.botT0)},${zToY(w.core.zBot)} ${tToX(sg.botT1)},${zToY(w.core.zBot)} ${tToX(sg.topT1)},${zToY(w.core.zTop)} ${tToX(sg.topT0)},${zToY(w.core.zTop)}`}
              fill={w.color || '#7dd3fc'} opacity={0.85} stroke={w.color || '#7dd3fc'} strokeWidth="0.5" />
          ))}
        </g>
      ))}

      {/* conductors: solid rects per crossed interval; zero-thickness sheets
          draw as fixed 3-px bars (they'd be invisible at true scale) */}
      {conductors.map((c) => {
        const role = roles[c.id] === 'ground' ? 'ground' : 'signal';
        const badge = role === 'ground' ? 'G' : `S${sigIds.indexOf(c.id) + 1}`;
        const yA = zToY(c.z1), yB = zToY(c.z0);
        return (
          <g key={c.id}>
            {(c.intervals || []).map((iv, i) => {
              const xa = tToX(iv.t0), xb = tToX(iv.t1);
              const zt = !!c.zeroThickness;
              const ry = zt ? zToY(c.z0) - 1.5 : yA;
              const rh = zt ? 3 : Math.max(yB - yA, 1);
              return (
                <g key={i}>
                  <rect x={xa} y={ry} width={Math.max(xb - xa, 1)} height={rh}
                    fill={c.color || '#fbbf24'} opacity={0.9} stroke={c.color || '#fbbf24'} strokeWidth="0.5" />
                  <text x={(xa + xb) / 2} y={ry - 3} fontSize="9" fontWeight="600" textAnchor="middle"
                    fill={role === 'ground' ? '#94a3b8' : '#22d3ee'}>{badge}</text>
                </g>
              );
            })}
          </g>
        );
      })}

      {/* wg-center crosshair — the mode-solver / EO overlap anchor */}
      {highlightWgCenter && cross.wgCenter && (
        <g stroke="#f472b6" strokeWidth="1">
          <line x1={tToX(cross.wgCenter.t) - 6} y1={zToY(cross.wgCenter.z)} x2={tToX(cross.wgCenter.t) + 6} y2={zToY(cross.wgCenter.z)} />
          <line x1={tToX(cross.wgCenter.t)} y1={zToY(cross.wgCenter.z) - 6} x2={tToX(cross.wgCenter.t)} y2={zToY(cross.wgCenter.z) + 6} />
          <circle cx={tToX(cross.wgCenter.t)} cy={zToY(cross.wgCenter.z)} r="2.5" fill="none" />
        </g>
      )}

      {/* axes */}
      <line x1={x0} y1={yBot} x2={x1} y2={yBot} stroke="#475569" strokeWidth="1" />
      <line x1={x0} y1={yTop} x2={x0} y2={yBot} stroke="#475569" strokeWidth="1" />
      {tTicks.map((t) => (
        <g key={t}>
          <line x1={tToX(t)} y1={yBot} x2={tToX(t)} y2={yBot + 3} stroke="#475569" strokeWidth="1" />
          <text x={tToX(t)} y={yBot + 12} fontSize="8" textAnchor="middle" fill="#64748b">{fmt(t)}</text>
        </g>
      ))}
      <text x={x1} y={yBot + 12} fontSize="8" textAnchor="end" fill="#475569">t (µm)</text>
      {zTicks.map(({ z, y }) => (
        <g key={z}>
          <line x1={x0 - 3} y1={y} x2={x0} y2={y} stroke="#475569" strokeWidth="1" />
          <text x={x0 - 5} y={y + 2.5} fontSize="8" textAnchor="end" fill="#64748b">{fmt(z)}</text>
        </g>
      ))}
      {breakBelow && breakMark(ys[1], 'bb')}
      {breakAbove && breakMark(ys[2], 'ba')}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// ConductorRoleTable — the Signal/Ground assignment table BOTH wizards embed
// (Q2D + Tidy3D), so the role UX can't drift between them.
// Props: conductors (cross.conductors), roles (EFFECTIVE map incl. defaults),
// onSetRole(id, 'signal'|'ground').
// ---------------------------------------------------------------------------
export function ConductorRoleTable({ conductors, roles = {}, onSetRole }) {
  const cellCls = 'px-2 py-1';
  return (
    <div className="rounded border border-slate-800 bg-slate-900/40 overflow-hidden">
      <table className="w-full text-[11px] text-slate-300">
        <thead>
          <tr className="text-[10px] uppercase tracking-wider text-slate-500 border-b border-slate-800">
            <th className={`${cellCls} text-left font-medium`}>conductor</th>
            <th className={`${cellCls} text-right font-medium`}>area (µm²)</th>
            <th className={`${cellCls} text-right font-medium`}>z (µm)</th>
            <th className={`${cellCls} text-right font-medium`}>xings</th>
            <th className={`${cellCls} text-left font-medium`}>role</th>
          </tr>
        </thead>
        <tbody>
          {(conductors || []).map((c) => (
            <tr key={c.id} className="border-b border-slate-800/60 last:border-0">
              <td className={`${cellCls} font-mono`} title={c.id}>{c.id}{c.label && c.label !== c.id ? <span className="text-slate-500"> ({c.label})</span> : null}{c.zeroThickness && <span className="text-slate-500"> (sheet)</span>}</td>
              <td className={`${cellCls} text-right font-mono`}>{fmt(c.areaUm2)}</td>
              <td className={`${cellCls} text-right font-mono`}>{fmt(c.z0)}…{fmt(c.z1)}</td>
              <td className={`${cellCls} text-right font-mono`}>{(c.intervals || []).length}</td>
              <td className={cellCls}>
                <select
                  className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-100 text-[11px] focus:outline-none focus:border-cyan-500"
                  value={roles[c.id] === 'ground' ? 'ground' : 'signal'}
                  onChange={(e) => onSetRole && onSetRole(c.id, e.target.value)}
                >
                  <option value="signal">Signal</option>
                  <option value="ground">Ground</option>
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
