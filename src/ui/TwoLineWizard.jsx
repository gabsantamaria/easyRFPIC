// TwoLineWizard — Marks' 2-line method (IEEE-MTT 1991).
//
// Opened from the export menu. Takes the user's SINGLE transmission-line
// design, asks which workspace parameter controls the line length, and
// generates ONE native HFSS COM script that:
//   • builds the line at TWO lengths (lineA = tl_L1, lineB = tl_L2, offset
//     apart) as a 4-lumped-port design, and
//   • adds HFSS Output Variables + reports that extract the propagation
//     constant γ from the two lines' S-parameters and from it the effective
//     permittivity εeff and attenuation α — ALL math done in HFSS.
// The user just runs the script in HFSS (Tools → Run Script), Analyzes
// Setup1:Sweep, and reads the "eeff vs Freq" / "alpha vs Freq" reports.
//
// Everything parametric stays parametric: tl_L1/tl_L2/tl_dL are real HFSS
// variables, so the user can sweep the lengths in HFSS afterward.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Ruler, X as XIcon, AlertTriangle, Check, Download } from 'lucide-react';
import { buildTwoLineScene } from '../scene/twoLine.js';
import { evalExpr } from '../scene/params.js';
import { loadTwoLinePrefs, saveTwoLinePrefs } from './twoLineSettings.js';

const C_LIGHT = 2.99792458e8;

// Thin wrapper so the stateful body MOUNTS fresh on each open (state
// initializers re-run; nothing leaks across opens).
export function TwoLineWizard(props) {
  if (!props.open) return null;
  return <TwoLineWizardInner {...props} />;
}

function TwoLineWizardInner({ onClose, scene, paramValues, onGenerate, onGenerateQ3D, onGenerateZ0Transfer }) {
  // Candidate length params: everything the user authored, minus the synthetic
  // per-component position/size params (_comp_*). Sorted for stable display.
  const paramNames = useMemo(() => Object.keys(scene.params || {})
    .filter((n) => !n.startsWith('_comp_'))
    .sort((a, b) => a.localeCompare(b)), [scene]);

  // Last-used field values. Loaded synchronously on mount from the in-memory
  // session cache (set on every change — survives close→reopen even if browser
  // storage is blocked), backed by IndexedDB across reloads (see
  // twoLineSettings.js). A saved lengthParam that no longer exists in this
  // design falls back to the first.
  const prefs = useMemo(() => loadTwoLinePrefs(), []);
  const savedParamOk = prefs && prefs.lengthParam && paramNames.includes(prefs.lengthParam);

  const [lengthParam, setLengthParam] = useState(() => (savedParamOk ? prefs.lengthParam : (paramNames[0] || '')));
  const curLen = Number(paramValues?.[lengthParam]);
  const defL1 = Number.isFinite(curLen) && curLen > 0 ? String(Math.round(curLen)) : '1000';
  const defL2 = Number.isFinite(curLen) && curLen > 0 ? String(Math.round(curLen * 2)) : '2000';
  const [l1, setL1] = useState(() => (prefs && prefs.l1 ? prefs.l1 : defL1));
  const [l2, setL2] = useState(() => (prefs && prefs.l2 ? prefs.l2 : defL2));
  const [separation, setSeparation] = useState(() => (prefs ? prefs.separation : '')); // blank = auto
  const sim = scene.simSetup || {};
  const [freqStart, setFreqStart] = useState(() => (prefs && prefs.freqStart ? prefs.freqStart : String(sim.sweepStart ?? '1')));
  const [freqStop, setFreqStop] = useState(() => (prefs && prefs.freqStop ? prefs.freqStop : String(sim.sweepStop ?? '40')));
  const [freqPoints, setFreqPoints] = useState(() => (prefs && prefs.freqPoints ? prefs.freqPoints : String(sim.sweepPoints ?? '201')));
  // Optional per-length capacitance C (F/m) → enables Z0 = γ/(jωC) output.
  // Get it from a Q3D capacitance ÷ physical length (button below).
  const [cFperM, setCFperM] = useState(() => (prefs && prefs.cFperM ? prefs.cFperM : ''));

  // Conductor components selectable for the Q3D capacitance run (exclude
  // booleans/feeds; the user picks the LINE conductor).
  const conductorComps = useMemo(() => (scene.components || [])
    .filter((c) => c.layer === 'electrode' && c.kind !== 'boolean'), [scene]);
  // Restore last-picked conductors, filtered to those that still exist here.
  const [q3dPick, setQ3dPick] = useState(() => new Set(
    (prefs && Array.isArray(prefs.q3dIds) ? prefs.q3dIds : []).filter((id) => conductorComps.some((c) => c.id === id)),
  ));
  const toggleQ3dPick = (id) => setQ3dPick((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  // When on (and conductors picked), the MAIN 2-line script also builds a Q3D
  // capacitance design in the same project that solves C → Z0.
  const [bundleQ3D, setBundleQ3D] = useState(() => !!(prefs && prefs.bundleQ3D));
  // Thin-conductor thickness for Q3D: default to the stack's h_cond; if that's 0
  // (zero-thickness/superconductor sheet) the user must supply a value.
  const condThkResolved = useMemo(() => {
    const cl = (scene.stack || []).find((l) => l.role === 'conductor');
    if (!cl) return 0;
    const v = evalExpr(cl.thickness, paramValues || {});
    return Number.isFinite(v) ? v : 0;
  }, [scene, paramValues]);
  const [q3dThk, setQ3dThk] = useState(() => (prefs && prefs.q3dThk ? prefs.q3dThk : (condThkResolved > 0 ? String(condThkResolved) : '')));
  const [q3dLen, setQ3dLen] = useState(() => (prefs && prefs.q3dLen ? prefs.q3dLen : '')); // line physical length (µm); blank = geometry guess
  // Q3D capacitance-setup convergence controls.
  const [q3dCg, setQ3dCg] = useState(() => (prefs && prefs.q3dCg ? prefs.q3dCg : '0.01'));      // CG % error (ΔC per pass)
  const [q3dMinP, setQ3dMinP] = useState(() => (prefs && prefs.q3dMinP ? prefs.q3dMinP : '15')); // min passes
  const [q3dMaxP, setQ3dMaxP] = useState(() => (prefs && prefs.q3dMaxP ? prefs.q3dMaxP : '20')); // max passes
  const thkNum = q3dThk.trim() === '' ? null : Number(q3dThk);
  const thkValid = thkNum != null && Number.isFinite(thkNum) && thkNum > 0;
  const lenNum = q3dLen.trim() === '' ? null : Number(q3dLen);
  const numOr = (s, d) => { const v = Number(s); return Number.isFinite(v) && v > 0 ? v : d; };
  // Options bundle passed to the Q3D generators (thickness, optional length, band, convergence).
  const q3dOpts = () => ({
    thicknessUm: thkValid ? thkNum : undefined,
    lengthUm: (lenNum != null && Number.isFinite(lenNum) && lenNum > 0) ? lenNum : undefined,
    freqStartGHz: freqStart.trim() === '' ? undefined : Number(freqStart),
    freqStopGHz: freqStop.trim() === '' ? undefined : Number(freqStop),
    freqPoints: freqPoints.trim() === '' ? undefined : Number(freqPoints),
    perError: numOr(q3dCg, 0.01),
    minPass: numOr(q3dMinP, 15),
    maxPass: numOr(q3dMaxP, 20),
  });

  // When the user CHANGES the length param, re-seed L1/L2 from its current
  // value. Detect a REAL change against the previous value (a ref) rather than
  // mount count — so restored last-used L1/L2 survive, and StrictMode's
  // double-invoked mount effect doesn't clobber them.
  const prevLenRef = useRef(lengthParam);
  useEffect(() => {
    if (lengthParam === prevLenRef.current) return;
    prevLenRef.current = lengthParam;
    const v = Number(paramValues?.[lengthParam]);
    if (Number.isFinite(v) && v > 0) { setL1(String(Math.round(v))); setL2(String(Math.round(v * 2))); }
  }, [lengthParam]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const cfg = useMemo(() => ({
    lengthParam,
    l1: l1.trim(), l2: l2.trim(),
    separation: separation.trim() === '' ? null : Number(separation),
    freqStart: freqStart.trim() === '' ? null : Number(freqStart),
    freqStop: freqStop.trim() === '' ? null : Number(freqStop),
    freqPoints: freqPoints.trim() === '' ? null : Number(freqPoints),
  }), [lengthParam, l1, l2, separation, freqStart, freqStop, freqPoints]);

  // Live build + validate (the same call Generate runs). Errors block; warnings
  // inform.
  const build = useMemo(() => {
    if (!lengthParam) return { error: 'Pick the parameter that controls the line length.' };
    try {
      const r = buildTwoLineScene(scene, cfg);
      return { ok: r };
    } catch (e) {
      return { error: e.message };
    }
  }, [scene, cfg, lengthParam]);

  // Phase-ambiguity guidance: the eigenvalue β is only unwrapped while
  // βΔl < π. With Δl = L2−L1 and the top sweep frequency, the largest εeff
  // for which that holds is εeff_max = (c / (2·f_max·Δl))². If that's below a
  // typical substrate εeff the user should shrink Δl.
  const phase = useMemo(() => {
    const dL_um = Number(l2) - Number(l1);
    const fmax = Number(freqStop) * 1e9;
    if (!Number.isFinite(dL_um) || dL_um <= 0 || !Number.isFinite(fmax) || fmax <= 0) return null;
    const dL_m = dL_um * 1e-6;
    const eeffMax = (C_LIGHT / (2 * fmax * dL_m)) ** 2;
    return { dL_um, eeffMax, risky: eeffMax < 5 };
  }, [l1, l2, freqStop]);

  const cNum = cFperM.trim() === '' ? null : Number(cFperM);
  const cValid = cNum != null && Number.isFinite(cNum) && cNum > 0;

  // Remember EVERY field for next time. Persist on every change (NOT only on
  // Generate) so the last-entered values survive even if the dialog is closed
  // without generating, or while the build is invalid (Generate disabled). The
  // mount run just re-saves the restored values — harmless.
  useEffect(() => {
    saveTwoLinePrefs({
      lengthParam, l1, l2, separation, freqStart, freqStop, freqPoints, cFperM,
      q3dThk, q3dLen, bundleQ3D, q3dIds: [...q3dPick], q3dCg, q3dMinP, q3dMaxP,
    });
  }, [lengthParam, l1, l2, separation, freqStart, freqStop, freqPoints, cFperM, q3dThk, q3dLen, bundleQ3D, q3dPick, q3dCg, q3dMinP, q3dMaxP]);

  const generate = () => {
    if (!build.ok) return;
    const bundle = (bundleQ3D && q3dPick.size > 0 && thkValid)
      ? { conductorIds: [...q3dPick], ...q3dOpts() }
      : undefined;
    onGenerate(build.ok.scene, build.ok.portIndices, build.ok.dLMeters, cValid ? cNum : undefined, bundle);
    onClose();
  };
  const generateQ3D = () => onGenerateQ3D([...q3dPick], q3dOpts());
  const generateZ0Transfer = () => onGenerateZ0Transfer([...q3dPick], q3dOpts());

  const fieldCls = 'w-full px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-100 text-xs focus:outline-none focus:border-cyan-500';
  const labelCls = 'text-[11px] text-slate-400';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(2,6,23,0.8)' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-[600px] max-w-[94vw] max-h-[90vh] flex flex-col rounded-lg border border-slate-700 shadow-2xl"
        style={{ background: '#0f172a' }}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-700">
          <Ruler size={15} className="text-cyan-400" />
          <span className="text-sm font-semibold text-slate-100">2-line method (εeff &amp; α)</span>
          <span className="text-[10px] text-slate-500">Marks 1991 · native HFSS script</span>
          <button onClick={onClose} className="ml-auto text-slate-400 hover:text-slate-200" aria-label="Close">
            <XIcon size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          <p className="text-[11px] text-slate-400 leading-relaxed">
            Your current design is the single line. Pick the parameter that sets its length; the wizard
            stamps it at two lengths (4 lumped ports) and writes one HFSS script that extracts
            <span className="text-slate-200"> εeff</span> and <span className="text-slate-200">α</span> directly
            in HFSS. Run it, Analyze, then read the <span className="font-mono text-slate-300">eeff/alpha vs Freq</span> reports.
          </p>

          {/* Length parameter */}
          <div className="space-y-1">
            <label className={labelCls}>Length parameter</label>
            {paramNames.length === 0 ? (
              <p className="text-[11px] text-red-400">This design has no parameters. Parametrize the line length first.</p>
            ) : (
              <select className={fieldCls} value={lengthParam} onChange={(e) => setLengthParam(e.target.value)}>
                {paramNames.map((n) => (
                  <option key={n} value={n}>
                    {n}{Number.isFinite(Number(paramValues?.[n])) ? ` (= ${paramValues[n]})` : ''}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* L1 / L2 */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className={labelCls}>Short line L1 (µm)</label>
              <input className={fieldCls} value={l1} onChange={(e) => setL1(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label className={labelCls}>Long line L2 (µm)</label>
              <input className={fieldCls} value={l2} onChange={(e) => setL2(e.target.value)} />
            </div>
          </div>

          {/* Separation + freq band */}
          <div className="grid grid-cols-4 gap-3">
            <div className="space-y-1">
              <label className={labelCls}>Separation (µm)</label>
              <input className={fieldCls} value={separation} placeholder="auto" onChange={(e) => setSeparation(e.target.value)} />
            </div>
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
          </div>

          {/* Characteristic impedance Z0 (optional) */}
          <div className="rounded border border-slate-800 px-3 py-2 space-y-2" style={{ background: 'rgba(30,41,59,0.5)' }}>
            <p className="text-[10px] uppercase tracking-wider text-slate-500">Characteristic impedance Z₀ (optional)</p>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              The 2-line method gives γ (→ εeff, α) only — Z₀ needs the per-length capacitance.
              Enter <span className="font-mono">C</span> in F/m and the script also emits
              <span className="font-mono text-slate-300"> Z₀ = γ/(jωC)</span> (kinetic-inductance-correct). Get C from a
              Q3D capacitance ÷ the line's physical length.
            </p>
            <div className="space-y-1">
              <label className={labelCls}>C per length (F/m)</label>
              <input className={fieldCls} value={cFperM} placeholder="e.g. 1.6e-10 (leave blank to skip Z₀)" onChange={(e) => setCFperM(e.target.value)} />
            </div>
            {cFperM.trim() !== '' && !cValid && (
              <p className="text-[11px] text-red-400">C must be a positive number in F/m (e.g. 1.6e-10).</p>
            )}
            {cValid && (
              <p className="text-[11px] text-emerald-400">Z₀ output variables + report will be included.</p>
            )}

            {/* Q3D capacitance helper: pick the line conductor(s) → generate Q3D script */}
            {onGenerateQ3D && (
              <div className="pt-1 border-t border-slate-800 space-y-1.5">
                <p className="text-[11px] text-slate-400">
                  Don't have C yet? Pick the <span className="text-slate-200">line conductor(s)</span> (not the feeds) and
                  generate a Q3D script to solve it:
                </p>
                <div className="max-h-24 overflow-y-auto rounded border border-slate-800 bg-slate-900/40 px-2 py-1 space-y-0.5">
                  {conductorComps.length === 0 ? (
                    <p className="text-[11px] text-slate-500">No conductor components found.</p>
                  ) : conductorComps.map((c) => (
                    <label key={c.id} className="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer">
                      <input type="checkbox" checked={q3dPick.has(c.id)} onChange={() => toggleQ3dPick(c.id)} />
                      <span className="font-mono">{c.id}</span>
                      {c.label && c.label !== c.id && <span className="text-slate-500">({c.label})</span>}
                    </label>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className={labelCls}>Conductor thickness (µm)</label>
                    <input className={fieldCls} value={q3dThk}
                      placeholder={condThkResolved > 0 ? `h_cond = ${condThkResolved}` : 'required (h_cond = 0)'}
                      onChange={(e) => setQ3dThk(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <label className={labelCls}>Line physical length (µm)</label>
                    <input className={fieldCls} value={q3dLen} placeholder="auto (geometry) — set unfolded length"
                      onChange={(e) => setQ3dLen(e.target.value)} />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <label className={labelCls}>CG error (%)</label>
                    <input className={fieldCls} value={q3dCg} placeholder="0.01" onChange={(e) => setQ3dCg(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <label className={labelCls}>Min passes</label>
                    <input className={fieldCls} value={q3dMinP} placeholder="15" onChange={(e) => setQ3dMinP(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <label className={labelCls}>Max passes</label>
                    <input className={fieldCls} value={q3dMaxP} placeholder="20" onChange={(e) => setQ3dMaxP(e.target.value)} />
                  </div>
                </div>
                {q3dPick.size > 0 && !thkValid && (
                  <p className="text-[11px] text-amber-400">Set a conductor thickness (µm) — it's a thin conductor of this height ({condThkResolved > 0 ? 'defaults to h_cond' : 'h_cond is 0, so required'}).</p>
                )}
                <label className="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer">
                  <input type="checkbox" checked={bundleQ3D} disabled={q3dPick.size === 0 || !thkValid}
                    onChange={(e) => setBundleQ3D(e.target.checked)} />
                  <span>Bundle the Q3D design into the main 2-line script (one project)</span>
                </label>
                <div className="flex items-center gap-2">
                  <button
                    onClick={generateQ3D}
                    disabled={q3dPick.size === 0 || !thkValid}
                    className="px-2.5 py-1 rounded text-[11px] font-medium border border-slate-600 hover:bg-slate-800 text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed"
                    title="Generate a SEPARATE Q3D Extractor script: builds the selected conductor(s) as thin conductors + dielectric stack, assigns nets, runs a capacitance setup + frequency sweep, and reports C per length. Paste the resulting C (F/m) above. (Q3D COM differs from HFSS — validate in AEDT.)"
                  >
                    Separate Q3D script…
                  </button>
                  {bundleQ3D && q3dPick.size > 0 && (
                    <span className="text-[11px] text-cyan-400">↑ also built into the main script on Generate</span>
                  )}
                </div>
                {onGenerateZ0Transfer && (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={generateZ0Transfer}
                      disabled={q3dPick.size < 2}
                      className="px-2.5 py-1 rounded text-[11px] font-medium border border-slate-600 hover:bg-slate-800 text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed"
                      title="Generate a SEPARATE 'Z₀ from Q3D C' script to run on the SOLVED combined project (Q3D + 2-line HFSS both solved). It reads the Q3D capacitance matrix, sets tl_C_F_per_m as a POST-PROCESSING variable on the HFSS design (no re-solve), and plots Re/Im Z₀ vs Freq. Needs ≥2 conductors (differential C). The computed C is echoed with sanity bounds so a mis-read is visible."
                    >
                      Z₀-from-Q3D script…
                    </button>
                    <span className="text-[11px] text-slate-500">run after solving both designs</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Phase-ambiguity guidance */}
          {phase && (
            <div className={`rounded border px-3 py-2 text-[11px] leading-relaxed ${phase.risky ? 'border-amber-700 bg-amber-950/30 text-amber-200' : 'border-slate-800 bg-slate-800/40 text-slate-400'}`}>
              {phase.risky && <AlertTriangle size={12} className="inline mr-1 -mt-0.5 text-amber-400" />}
              Δl = {phase.dL_um} µm. β is unambiguous while εeff &lt; {phase.eeffMax.toFixed(1)} over the band
              (βΔl &lt; π at {freqStop} GHz). {phase.risky
                ? 'That is below a typical substrate εeff — shrink L2−L1 or lower f stop, or the β/εeff trace will wrap (α is unaffected).'
                : 'Comfortable margin for typical substrates.'}
            </div>
          )}

          {/* Validation status */}
          {build.error ? (
            <div className="rounded border border-red-800 bg-red-950/40 px-3 py-2 text-[11px] text-red-300 flex gap-2">
              <AlertTriangle size={13} className="flex-shrink-0 mt-0.5 text-red-400" />
              <span>{build.error}</span>
            </div>
          ) : build.ok && (
            <div className="rounded border border-emerald-800 bg-emerald-950/30 px-3 py-2 text-[11px] text-emerald-300 space-y-1">
              <div className="flex gap-2"><Check size={13} className="flex-shrink-0 mt-0.5" />
                <span>4 lumped ports verified — line A = ports 1,2; line B = ports 3,4.</span>
              </div>
              {build.ok.warnings && build.ok.warnings.length > 0 && (
                <ul className="list-disc ml-6 text-amber-300/90">
                  {build.ok.warnings.slice(0, 5).map((w, i) => <li key={i}>{typeof w === 'string' ? w : (w.message || JSON.stringify(w))}</li>)}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-t border-slate-700">
          <span className="text-[10px] text-slate-500">HFSS 2023 · run via Tools → Run Script, then Analyze Setup1:Sweep</span>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={onClose} className="px-3 py-1 rounded text-xs text-slate-300 hover:bg-slate-800">Cancel</button>
            <button
              onClick={generate}
              disabled={!build.ok}
              className="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ background: '#06b6d4', color: '#0f172a' }}
            >
              <Download size={13} /> Generate HFSS script
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
