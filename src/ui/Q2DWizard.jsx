// Q2DWizard — Ansys 2D Extractor cross-section export.
//
// Opened from the export menu with a SECTION LINE selected. The section line
// slices the 3-D layer stack; buildCrossSection turns that slice into the
// shared cross-section contract, and generateQ2DExtractor writes a Q2D
// (2D Extractor) script that rebuilds the slice as 2-D sheets, assigns
// signal/ground conductors from the role table, and solves RLGC/Z0 over the
// frequency band. The user runs it in AEDT (Tools → Run Script) and Analyzes.
import { useEffect, useMemo, useState } from 'react';
import { Scissors, X as XIcon, AlertTriangle, Check, Download } from 'lucide-react';
import { buildCrossSection } from '../scene/cross-section.js';
import { generateQ2DExtractor, validateQ2DRoles } from '../export/q2d.js';
import { CrossSectionPreview, ConductorRoleTable } from './CrossSectionPreview.jsx';
import { loadSectionWizardPrefs, saveSectionWizardPrefs, defaultRoles } from './sectionWizardSettings.js';

// Thin wrapper so the stateful body MOUNTS fresh on each open (state
// initializers re-run; nothing leaks across opens).
export function Q2DWizard(props) {
  if (!props.open) return null;
  return <Q2DWizardInner {...props} />;
}

// validateQ2DRoles is being authored in parallel against the same contract —
// coerce whatever sane shape it returns (string[], { ok, error(s) }, boolean)
// into { ok, errors[] } so a signature drift degrades gracefully, not fatally.
function coerceValidation(v) {
  if (v == null) return { ok: true, errors: [] };
  if (Array.isArray(v)) return { ok: v.length === 0, errors: v.map(String) };
  if (typeof v === 'object') {
    const errors = Array.isArray(v.errors) ? v.errors.map(String) : (v.error ? [String(v.error)] : []);
    return { ok: v.ok !== false && errors.length === 0, errors };
  }
  return { ok: !!v, errors: v ? [] : ['Role assignment failed validation.'] };
}

function Q2DWizardInner({ onClose, scene, paramValues, sectionCompId, simSetup, designBaseName, projectName, designName, appendMode, onDownload }) {
  // Live slice — the SAME call Generate consumes. buildCrossSection reports
  // unusable input as { ok:false, error }, but a parallel-authored throw must
  // not white-screen the app, so belt-and-braces try/catch.
  const cross = useMemo(() => {
    try {
      return buildCrossSection(scene, paramValues, sectionCompId) || { ok: false, error: 'buildCrossSection returned nothing.' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }, [scene, paramValues, sectionCompId]);
  const conductors = cross.ok ? cross.conductors : [];

  // Last-used field values (layered persistence — see sectionWizardSettings.js).
  const prefs = useMemo(() => { const p = loadSectionWizardPrefs(); return p ? p.q2d : null; }, []);
  const sim = simSetup || {};
  const [freqStart, setFreqStart] = useState(() => (prefs && prefs.freqStart ? prefs.freqStart : String(sim.sweepStart ?? '1')));
  const [freqStop, setFreqStop] = useState(() => (prefs && prefs.freqStop ? prefs.freqStop : String(sim.sweepStop ?? '40')));
  const [freqPoints, setFreqPoints] = useState(() => (prefs && prefs.freqPoints ? prefs.freqPoints : String(sim.sweepPoints ?? '201')));
  // Adaptive (mesh-refinement) frequency — default the setup's solve freq,
  // else the top of the band (the conservative mesh).
  const [adaptiveFreq, setAdaptiveFreq] = useState(() => (prefs && prefs.adaptiveFreq ? prefs.adaptiveFreq : String(sim.frequency ?? sim.sweepStop ?? '40')));
  // Q2D convergence: CG (capacitance) + RL (resistance/inductance) per-pass
  // error percentages, and the adaptive pass budget.
  const [cgErr, setCgErr] = useState(() => (prefs && prefs.cgErr ? prefs.cgErr : '0.1'));
  const [rlErr, setRlErr] = useState(() => (prefs && prefs.rlErr ? prefs.rlErr : '0.1'));
  const [minPass, setMinPass] = useState(() => (prefs && prefs.minPass ? prefs.minPass : '1'));
  const [maxPass, setMaxPass] = useState(() => (prefs && prefs.maxPass ? prefs.maxPass : '16'));
  // Zero-thickness conductors can't be finite-conductivity 2-D solids in Q2D;
  // the generator extrudes them to this nominal thickness instead. Only shown
  // (and passed) when the slice actually contains a zero-thickness sheet.
  const [zeroThk, setZeroThk] = useState(() => (prefs && prefs.zeroThk ? prefs.zeroThk : ''));

  // Role map: heuristic defaults (big pours → ground) overlaid with the
  // user's explicit per-conductor picks. Only the OVERRIDES persist — frozen
  // defaults would go stale the moment the design changes.
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

  // Live role validation (needs ≥2 conductors, ≥1 signal + ≥1 ground, …) —
  // gates Generate the way buildTwoLineScene gates the 2-line wizard.
  const validation = useMemo(() => {
    if (!cross.ok) return null;
    try { return coerceValidation(validateQ2DRoles(cross, roles)); }
    catch (e) { return { ok: false, errors: [e.message] }; }
  }, [cross, roles]);

  const anyZeroThk = conductors.some((c) => c.zeroThickness);
  const zeroThkNum = zeroThk.trim() === '' ? null : Number(zeroThk);
  const zeroThkValid = !anyZeroThk || zeroThk.trim() === '' || (Number.isFinite(zeroThkNum) && zeroThkNum > 0);

  const [genError, setGenError] = useState(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Remember EVERY field on change (NOT only on Generate) so values survive
  // closing without generating. saveSectionWizardPrefs merges the q2d slice
  // per-field, so the mount run just re-saves the restored values (harmless)
  // and can never clobber the Tidy3D wizard's slice — that's the
  // StrictMode/hydration guard for this store.
  useEffect(() => {
    saveSectionWizardPrefs({ q2d: { freqStart, freqStop, freqPoints, adaptiveFreq, cgErr, rlErr, minPass, maxPass, zeroThk, roles: roleOverrides } });
  }, [freqStart, freqStop, freqPoints, adaptiveFreq, cgErr, rlErr, minPass, maxPass, zeroThk, roleOverrides]);

  const numOr = (s, d) => { const v = Number(s); return Number.isFinite(v) && v > 0 ? v : d; };

  const generate = () => {
    if (!cross.ok || !(validation && validation.ok) || !zeroThkValid) return;
    try {
      const script = generateQ2DExtractor(cross, {
        roles,
        freqStartGHz: numOr(freqStart, 1),
        freqStopGHz: numOr(freqStop, 40),
        freqPoints: numOr(freqPoints, 201),
        adaptFreqGHz: numOr(adaptiveFreq, numOr(freqStop, 40)),
        cgPerError: numOr(cgErr, 0.1),
        rlPerError: numOr(rlErr, 0.1),
        minPasses: numOr(minPass, 1),
        maxPasses: numOr(maxPass, 16),
        condThicknessUm: anyZeroThk && Number.isFinite(zeroThkNum) && zeroThkNum > 0 ? zeroThkNum : undefined,
        // AEDT project/design names + append mode (shared with the native HFSS
        // export). designName = version-tagged name; projectName = <ws>_<design>
        // for a fresh project; appendMode = new | project | design.
        designName: designName || designBaseName,
        projectName,
        appendMode,
      });
      onDownload(script, `${designBaseName || 'layout'}_q2d.py`);
      onClose();
    } catch (e) {
      setGenError(e.message); // generator authored in parallel — fail loud, in-dialog
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
          <Scissors size={15} className="text-cyan-400" />
          <span className="text-sm font-semibold text-slate-100">Q2D cross-section (RLGC &amp; Z₀)</span>
          <span className="text-[10px] text-slate-500">Ansys 2D Extractor script</span>
          <button onClick={onClose} className="ml-auto text-slate-400 hover:text-slate-200" aria-label="Close">
            <XIcon size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          <p className="text-[11px] text-slate-400 leading-relaxed">
            The section line slices the layer stack into a 2-D cross-section
            {cross.ok && <> (<span className="font-mono text-slate-300">{cross.line.lengthUm.toFixed(0)} µm</span>, {axisLabel})</>}.
            Assign each crossed conductor a <span className="text-slate-200">Signal</span>/<span className="text-slate-200">Ground</span> role,
            then generate a 2D Extractor script that rebuilds the slice and solves the
            <span className="text-slate-200"> RLGC line parameters</span> and <span className="text-slate-200">Z₀</span> over the band.
          </p>

          {/* Unusable slice — show the contract error prominently, nothing else to do */}
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
                  <p className="text-[11px] text-red-400">The section line crosses no conductors — move it across the transmission line.</p>
                ) : (
                  <ConductorRoleTable conductors={conductors} roles={roles} onSetRole={setRole} />
                )}
              </div>

              {/* Frequency band + adaptive freq */}
              <div className="grid grid-cols-4 gap-3">
                <div className="space-y-1">
                  <label className={labelCls}>f start (GHz)</label>
                  <input className={fieldCls} value={freqStart} onChange={(e) => setFreqStart(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <label className={labelCls}>f stop (GHz)</label>
                  <input className={fieldCls} value={freqStop} onChange={(e) => setFreqStop(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <label className={labelCls}>points</label>
                  <input className={fieldCls} value={freqPoints} onChange={(e) => setFreqPoints(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <label className={labelCls}>adaptive f (GHz)</label>
                  <input className={fieldCls} value={adaptiveFreq} onChange={(e) => setAdaptiveFreq(e.target.value)} />
                </div>
              </div>

              {/* Convergence */}
              <div className="grid grid-cols-4 gap-3">
                <div className="space-y-1">
                  <label className={labelCls}>CG error (%)</label>
                  <input className={fieldCls} value={cgErr} placeholder="0.1" onChange={(e) => setCgErr(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <label className={labelCls}>RL error (%)</label>
                  <input className={fieldCls} value={rlErr} placeholder="0.1" onChange={(e) => setRlErr(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <label className={labelCls}>Min passes</label>
                  <input className={fieldCls} value={minPass} placeholder="1" onChange={(e) => setMinPass(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <label className={labelCls}>Max passes</label>
                  <input className={fieldCls} value={maxPass} placeholder="16" onChange={(e) => setMaxPass(e.target.value)} />
                </div>
              </div>

              {/* Zero-thickness conductors: Q2D needs a finite metal height */}
              {anyZeroThk && (
                <div className="rounded border border-slate-800 px-3 py-2 space-y-1.5" style={{ background: 'rgba(30,41,59,0.5)' }}>
                  <p className="text-[10px] uppercase tracking-wider text-slate-500">Zero-thickness conductors</p>
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    Some crossed conductors sit on a zero-thickness layer (drawn as 3-px bars above).
                    Q2D solves finite 2-D metal, so they're extruded to this nominal thickness in the script.
                  </p>
                  <div className="space-y-1">
                    <label className={labelCls}>Thickness (µm)</label>
                    <input className={fieldCls} value={zeroThk} placeholder="generator default" onChange={(e) => setZeroThk(e.target.value)} />
                  </div>
                  {!zeroThkValid && (
                    <p className="text-[11px] text-red-400">Thickness must be a positive number in µm (or blank for the generator default).</p>
                  )}
                </div>
              )}

              {/* Validation status */}
              {validation && !validation.ok ? (
                <div className="rounded border border-red-800 bg-red-950/40 px-3 py-2 text-[11px] text-red-300 flex gap-2">
                  <AlertTriangle size={13} className="flex-shrink-0 mt-0.5 text-red-400" />
                  <span>{validation.errors.join(' ') || 'Role assignment is invalid.'}</span>
                </div>
              ) : validation && (
                <div className="rounded border border-emerald-800 bg-emerald-950/30 px-3 py-2 text-[11px] text-emerald-300 flex gap-2">
                  <Check size={13} className="flex-shrink-0 mt-0.5" />
                  <span>
                    {conductors.length} conductors — {conductors.filter((c) => roles[c.id] !== 'ground').length} signal, {conductors.filter((c) => roles[c.id] === 'ground').length} ground.
                  </span>
                </div>
              )}

              {genError && (
                <div className="rounded border border-red-800 bg-red-950/40 px-3 py-2 text-[11px] text-red-300 flex gap-2">
                  <AlertTriangle size={13} className="flex-shrink-0 mt-0.5 text-red-400" />
                  <span>Script generation failed: {genError}</span>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-t border-slate-700">
          <span className="text-[10px] text-slate-500">AEDT 2D Extractor · run via Tools → Run Script (builds, solves, and plots Z₀ / √εeff / E)</span>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={onClose} className="px-3 py-1 rounded text-xs text-slate-300 hover:bg-slate-800">Cancel</button>
            <button
              onClick={generate}
              disabled={!cross.ok || !(validation && validation.ok) || !zeroThkValid}
              className="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ background: '#06b6d4', color: '#0f172a' }}
            >
              <Download size={13} /> Generate Q2D script
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
