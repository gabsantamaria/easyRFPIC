// Tidy3DWizard — electro-optic cross-section notebook (Z₀, √εeff, VπL).
//
// Same section-line slice as the Q2D wizard, different physics: the generated
// Jupyter notebook runs Tidy3D's mode solver on the optical waveguide, a 2-D
// electrostatic solve on the electrodes (from the Signal/Ground roles), and
// combines them through the Pockels effect (r33/r13, extraordinary-axis
// orientation) into the modulator figures of merit — RF Z₀, RF index
// √εeff, and the electro-optic VπL.
import { useEffect, useMemo, useState } from 'react';
import { Waves, X as XIcon, AlertTriangle, Check, Download } from 'lucide-react';
import { buildCrossSection } from '../scene/cross-section.js';
import { generateTidy3DNotebook } from '../export/tidy3d-notebook.js';
import { CrossSectionPreview, ConductorRoleTable } from './CrossSectionPreview.jsx';
import { loadSectionWizardPrefs, saveSectionWizardPrefs, defaultRoles } from './sectionWizardSettings.js';

// Thin wrapper so the stateful body MOUNTS fresh on each open (state
// initializers re-run; nothing leaks across opens).
export function Tidy3DWizard(props) {
  if (!props.open) return null;
  return <Tidy3DWizardInner {...props} />;
}

function Tidy3DWizardInner({ onClose, scene, paramValues, sectionCompId, simSetup, designBaseName, onDownload }) {
  // Live slice — the same contract object the Q2D wizard consumes.
  const cross = useMemo(() => {
    try {
      return buildCrossSection(scene, paramValues, sectionCompId) || { ok: false, error: 'buildCrossSection returned nothing.' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }, [scene, paramValues, sectionCompId]);
  const conductors = cross.ok ? cross.conductors : [];
  // EO-material candidates: every dielectric background slab (air excluded —
  // vacuum has no Pockels tensor). Default = the waveguide-role slab (the LN
  // film on a TFLN stack).
  const eoSlabs = useMemo(() => (cross.ok ? cross.slabs.filter((s) => s.role !== 'air') : []), [cross]);

  // Last-used field values (layered persistence — see sectionWizardSettings.js).
  const prefs = useMemo(() => { const p = loadSectionWizardPrefs(); return p ? p.tidy3d : null; }, []);
  const sim = simSetup || {};

  // Optics: wavelength + LN indices at 1550 nm (ne extraordinary, no
  // ordinary) and the Pockels coefficients (congruent LN: r33 = 30.8,
  // r13 = 8.6 pm/V).
  const [lambdaUm, setLambdaUm] = useState(() => (prefs && prefs.lambdaUm ? prefs.lambdaUm : '1.55'));
  const [ne, setNe] = useState(() => (prefs && prefs.ne ? prefs.ne : '2.138'));
  const [no, setNo] = useState(() => (prefs && prefs.no ? prefs.no : '2.211'));
  // Extraordinary-axis orientation decides which E-field component drives r33:
  // 'vertical' (stack normal) = z-cut LN, 'horizontal' (along the section
  // line) = x-cut LN with the line cut across the propagation direction.
  const [eoAxis, setEoAxis] = useState(() => (prefs && prefs.eoAxis === 'horizontal' ? 'horizontal' : 'vertical'));
  const [r33, setR33] = useState(() => (prefs && prefs.r33 ? prefs.r33 : '30.8'));
  const [r13, setR13] = useState(() => (prefs && prefs.r13 ? prefs.r13 : '8.6'));
  const [eoLayerId, setEoLayerId] = useState(() => {
    // Restore only if that slab still exists in THIS slice; else the
    // waveguide-role slab; else the first dielectric.
    const saved = prefs && prefs.eoLayerId;
    if (saved && eoSlabs.some((s) => s.layerId === saved)) return saved;
    const wg = eoSlabs.find((s) => s.role === 'waveguide');
    return wg ? wg.layerId : (eoSlabs[0] ? eoSlabs[0].layerId : '');
  });
  const [numModes, setNumModes] = useState(() => (prefs && prefs.numModes ? prefs.numModes : '2'));
  // The scene can change under an OPEN dialog (undo/redo runs at the window
  // level, unaffected by dialog focus) — a layer deleted mid-session leaves
  // eoLayerId pointing at nothing and the generator would fall back
  // silently. Re-validate whenever the slice recomputes.
  useEffect(() => {
    if (eoSlabs.some((sl) => sl.layerId === eoLayerId)) return;
    const wg = eoSlabs.find((sl) => sl.role === 'waveguide');
    setEoLayerId(wg ? wg.layerId : (eoSlabs[0] ? eoSlabs[0].layerId : ''));
  }, [eoSlabs, eoLayerId]);

  // RF band for the electrode solve / Z₀ (seeded from the design's sim setup,
  // same as the 2-line wizard).
  const [freqStart, setFreqStart] = useState(() => (prefs && prefs.freqStart ? prefs.freqStart : String(sim.sweepStart ?? '1')));
  const [freqStop, setFreqStop] = useState(() => (prefs && prefs.freqStop ? prefs.freqStop : String(sim.sweepStop ?? '40')));
  const [freqPoints, setFreqPoints] = useState(() => (prefs && prefs.freqPoints ? prefs.freqPoints : String(sim.sweepPoints ?? '201')));

  // Role map: heuristic defaults + explicit overrides (only overrides persist).
  const defRoles = useMemo(() => (cross.ok ? defaultRoles(cross) : {}), [cross]);
  const [roleOverrides, setRoleOverrides] = useState(() => (prefs && prefs.roles) || {});
  const roles = useMemo(() => {
    const out = { ...defRoles };
    for (const c of conductors) {
      if (roleOverrides[c.id] === 'signal' || roleOverrides[c.id] === 'ground') out[c.id] = roleOverrides[c.id];
    }
    return out;
  }, [defRoles, roleOverrides, conductors]);
  const setRole = (id, role) => setRoleOverrides((prev) => ({ ...prev, [id]: role }));

  // Local gates (the notebook needs a drivable line + a mode to perturb; the
  // deeper role validation lives in the Q2D exporter and isn't imported here).
  const nSig = conductors.filter((c) => roles[c.id] !== 'ground').length;
  const nGnd = conductors.length - nSig;
  const posNum = (s) => { const v = Number(s); return Number.isFinite(v) && v > 0; };
  const problems = [];
  if (cross.ok) {
    if (conductors.length < 2) problems.push('Needs ≥2 crossed conductors (signal + ground) to define the RF line.');
    else if (nSig === 0 || nGnd === 0) problems.push('Assign at least one Signal and one Ground.');
    // No waveguide is NOT a hard stop: the generator degrades gracefully
    // (VpiL/optical cells become explanatory markdown; the RF Z0/sqrt(eps_eff)
    // notebook is still produced) — slicing a bare CPW is a legitimate
    // RF-only use. Surfaced as an amber notice below instead.
    if (!posNum(lambdaUm)) problems.push('Wavelength must be a positive number (µm).');
    if (!posNum(ne) || !posNum(no)) problems.push('ne / no must be positive numbers.');
    if (!eoLayerId) problems.push('Pick the electro-optic layer.');
    if (!(Number.isFinite(Number(numModes)) && Number(numModes) >= 1)) problems.push('Mode count must be ≥ 1.');
  }

  const [genError, setGenError] = useState(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Remember EVERY field on change; the tidy3d slice merges per-field so this
  // can never clobber the Q2D wizard's slice (StrictMode's double mount just
  // re-saves the restored values — harmless).
  useEffect(() => {
    saveSectionWizardPrefs({ tidy3d: { lambdaUm, ne, no, eoAxis, r33, r13, eoLayerId, numModes, freqStart, freqStop, freqPoints, roles: roleOverrides } });
  }, [lambdaUm, ne, no, eoAxis, r33, r13, eoLayerId, numModes, freqStart, freqStop, freqPoints, roleOverrides]);

  const numOr = (s, d) => { const v = Number(s); return Number.isFinite(v) && v > 0 ? v : d; };

  const generate = () => {
    if (!cross.ok || problems.length > 0) return;
    try {
      const r = generateTidy3DNotebook(cross, {
        roles,
        lambdaUm: numOr(lambdaUm, 1.55),
        ne: numOr(ne, 2.138),
        no: numOr(no, 2.211),
        extraordinaryAxis: eoAxis, // 'vertical' (stack normal, z-cut) | 'horizontal' (along the line, x-cut)
        r33: numOr(r33, 30.8),   // pm/V
        r13: numOr(r13, 8.6),    // pm/V
        eoLayerId,
        nOpticalModes: Math.max(1, Math.round(Number(numModes) || 1)),
        freqStartGHz: numOr(freqStart, 1),
        freqStopGHz: numOr(freqStop, 40),
        freqPoints: numOr(freqPoints, 201),
        designName: designBaseName,
      });
      // Contract: result.ipynb is the notebook JSON string; accept a bare
      // string too (parallel-authored generator).
      const ipynb = typeof r === 'string' ? r : (r && r.ipynb);
      if (!ipynb) throw new Error('generator returned no notebook content');
      onDownload(ipynb, `${designBaseName || 'layout'}_eo_section.ipynb`);
      onClose();
    } catch (e) {
      setGenError(e.message); // fail loud, in-dialog
    }
  };

  const axisLabel = cross.ok ? (cross.line.axis === 'h' ? 'horizontal' : cross.line.axis === 'v' ? 'vertical' : 'oblique') : '';
  const fieldCls = 'w-full px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-100 text-xs focus:outline-none focus:border-cyan-500';
  const labelCls = 'text-[11px] text-slate-400';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(2,6,23,0.8)' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-[640px] max-w-[94vw] max-h-[90vh] flex flex-col rounded-lg border border-slate-700 shadow-2xl"
        style={{ background: '#0f172a' }}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-700">
          <Waves size={15} className="text-cyan-400" />
          <span className="text-sm font-semibold text-slate-100">Tidy3D EO cross-section (Z₀, √εeff, VπL)</span>
          <span className="text-[10px] text-slate-500">Jupyter notebook</span>
          <button onClick={onClose} className="ml-auto text-slate-400 hover:text-slate-200" aria-label="Close">
            <XIcon size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          <p className="text-[11px] text-slate-400 leading-relaxed">
            The section line slices the stack into a 2-D cross-section
            {cross.ok && <> (<span className="font-mono text-slate-300">{cross.line.lengthUm.toFixed(0)} µm</span>, {axisLabel})</>}.
            The notebook mode-solves the waveguide (Tidy3D), solves the electrode field from the Signal/Ground roles, and combines them via the
            Pockels effect into <span className="text-slate-200">Z₀</span>, <span className="text-slate-200">√εeff</span> and the
            electro-optic <span className="text-slate-200">VπL</span>.
          </p>

          {!cross.ok ? (
            <div className="rounded border border-red-800 bg-red-950/40 px-3 py-2 text-[11px] text-red-300 flex gap-2">
              <AlertTriangle size={13} className="flex-shrink-0 mt-0.5 text-red-400" />
              <span>{cross.error || 'Could not build a cross-section from this section line.'}</span>
            </div>
          ) : (
            <>
              {/* Slice preview */}
              <div className="rounded border border-slate-800 bg-slate-900/40 p-2">
                <CrossSectionPreview cross={cross} roles={roles} />
              </div>

              {cross.warnings && cross.warnings.length > 0 && (
                <div className="rounded border border-amber-700 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-200">
                  <ul className="list-disc ml-4 space-y-0.5">
                    {cross.warnings.slice(0, 6).map((w, i) => <li key={i}>{w.msg || w.code || String(w)}</li>)}
                  </ul>
                </div>
              )}

              {/* Conductor roles */}
              <div className="space-y-1">
                <label className={labelCls}>Conductor roles</label>
                {conductors.length === 0 ? (
                  <p className="text-[11px] text-red-400">The section line crosses no conductors — move it across the electrodes.</p>
                ) : (
                  <ConductorRoleTable conductors={conductors} roles={roles} onSetRole={setRole} />
                )}
              </div>

              {/* Optics */}
              <div className="rounded border border-slate-800 px-3 py-2 space-y-2" style={{ background: 'rgba(30,41,59,0.5)' }}>
                <p className="text-[10px] uppercase tracking-wider text-slate-500">Optical mode &amp; electro-optic material</p>
                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <label className={labelCls}>λ (µm)</label>
                    <input className={fieldCls} value={lambdaUm} onChange={(e) => setLambdaUm(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <label className={labelCls}>ne (extraordinary)</label>
                    <input className={fieldCls} value={ne} onChange={(e) => setNe(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <label className={labelCls}>no (ordinary)</label>
                    <input className={fieldCls} value={no} onChange={(e) => setNo(e.target.value)} />
                  </div>
                </div>
                <div className="space-y-1">
                  <label className={labelCls}>Extraordinary (optic) axis</label>
                  <select className={fieldCls} value={eoAxis} onChange={(e) => setEoAxis(e.target.value)}>
                    <option value="vertical">vertical — stack normal (z-cut LN)</option>
                    <option value="horizontal">horizontal — along the section line (x-cut LN)</option>
                  </select>
                  <p className="text-[10px] text-slate-500">
                    Decides which electrode-field component drives <span className="font-mono">r33</span>: the vertical field for z-cut,
                    the in-plane field across the gap for x-cut.
                  </p>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <label className={labelCls}>r33 (pm/V)</label>
                    <input className={fieldCls} value={r33} onChange={(e) => setR33(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <label className={labelCls}>r13 (pm/V)</label>
                    <input className={fieldCls} value={r13} onChange={(e) => setR13(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <label className={labelCls}>optical modes</label>
                    <input className={fieldCls} value={numModes} onChange={(e) => setNumModes(e.target.value)} />
                  </div>
                </div>
                <div className="space-y-1">
                  <label className={labelCls}>Electro-optic layer</label>
                  <select className={fieldCls} value={eoLayerId} onChange={(e) => setEoLayerId(e.target.value)}>
                    {eoSlabs.map((s) => (
                      <option key={s.layerId} value={s.layerId}>
                        {s.name} ({s.material}){s.role === 'waveguide' ? ' — waveguide layer' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* RF band */}
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <label className={labelCls}>RF f start (GHz)</label>
                  <input className={fieldCls} value={freqStart} onChange={(e) => setFreqStart(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <label className={labelCls}>RF f stop (GHz)</label>
                  <input className={fieldCls} value={freqStop} onChange={(e) => setFreqStop(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <label className={labelCls}>points</label>
                  <input className={fieldCls} value={freqPoints} onChange={(e) => setFreqPoints(e.target.value)} />
                </div>
              </div>

              {/* No-waveguide amber notice: RF-only notebooks are legit
                  (bare CPW slice) — the generator swaps the optical/VpiL
                  cells for explanatory markdown. */}
              {cross.ok && (cross.waveguides || []).length === 0 && (
                <div className="rounded border border-amber-700 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-200 flex gap-2">
                  <AlertTriangle size={13} className="flex-shrink-0 mt-0.5 text-amber-400" />
                  <span>No waveguide crossed — the notebook will contain the RF line solve (Z₀, √εeff) only; the optical mode + VπL cells become explanatory markdown.</span>
                </div>
              )}
              {/* Validation status */}
              {problems.length > 0 ? (
                <div className="rounded border border-red-800 bg-red-950/40 px-3 py-2 text-[11px] text-red-300 flex gap-2">
                  <AlertTriangle size={13} className="flex-shrink-0 mt-0.5 text-red-400" />
                  <span>{problems.join(' ')}</span>
                </div>
              ) : (
                <div className="rounded border border-emerald-800 bg-emerald-950/30 px-3 py-2 text-[11px] text-emerald-300 flex gap-2">
                  <Check size={13} className="flex-shrink-0 mt-0.5" />
                  <span>
                    {conductors.length} conductors ({nSig} signal, {nGnd} ground), {(cross.waveguides || []).length} waveguide{(cross.waveguides || []).length === 1 ? '' : 's'} crossed
                    {cross.wgCenter ? ' — mode solver centered on the crosshair.' : '.'}
                  </span>
                </div>
              )}

              {genError && (
                <div className="rounded border border-red-800 bg-red-950/40 px-3 py-2 text-[11px] text-red-300 flex gap-2">
                  <AlertTriangle size={13} className="flex-shrink-0 mt-0.5 text-red-400" />
                  <span>Notebook generation failed: {genError}</span>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-t border-slate-700">
          <span className="text-[10px] text-slate-500">Runs locally in Jupyter · needs tidy3d + numpy + matplotlib</span>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={onClose} className="px-3 py-1 rounded text-xs text-slate-300 hover:bg-slate-800">Cancel</button>
            <button
              onClick={generate}
              disabled={!cross.ok || problems.length > 0}
              className="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ background: '#06b6d4', color: '#0f172a' }}
            >
              <Download size={13} /> Generate notebook
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
