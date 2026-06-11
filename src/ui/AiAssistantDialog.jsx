// AiAssistantDialog — natural-language / sketch → parametric geometry.
//
// Opened from the ✨ button in the header. The user types a description
// of an RF/photonic structure and/or attaches sketch images (file pick,
// drag-drop, or paste), and Claude — called directly from the browser
// with the user's own API key — returns a parametric scene fragment
// (params + components + snaps) that inserts at the viewport center
// like a built-in template (one undo step).
//
// Settings (API key + model) persist in localStorage only — see
// src/ai/settings.js. The fragment is validated (expressions evaluate,
// snap graph stays a clean DAG, trial solve passes) before the Insert
// button is enabled; validation errors and Claude's clarifying
// questions are surfaced inline.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, X as XIcon, Eye, EyeOff, ImagePlus, Loader2, AlertTriangle, Check } from 'lucide-react';
import { buildSystemPrompt, normalizeFragment, validateFragment, suggestPrefix } from '../ai/assistant.js';
import { requestGeometry, fileToImagePayload, AI_MODELS } from '../ai/client.js';
import { loadAiSettings, saveAiSettings } from '../ai/settings.js';

// Thin wrapper so the stateful dialog MOUNTS on open: the useState
// initializers (notably loadAiSettings) re-run on every open without a
// setState-in-effect, and Escape/draft state never leaks across opens.
export function AiAssistantDialog(props) {
  if (!props.open) return null;
  return <AiAssistantDialogInner {...props} />;
}

function AiAssistantDialogInner({ onClose, scene, paramValues, onApply }) {
  const [settings, setSettings] = useState(() => loadAiSettings());
  const [showKey, setShowKey] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [images, setImages] = useState([]); // [{ mediaType, data, name, previewUrl }]
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { fragment, message } | { error }
  const fileInputRef = useRef(null);
  const textareaRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const updateSettings = (patch) => {
    setSettings(prev => {
      const next = { ...prev, ...patch };
      saveAiSettings(next);
      return next;
    });
  };

  const prefix = useMemo(() => suggestPrefix(scene), [scene]);

  // Validation of the (normalized) fragment against the live scene —
  // recomputed if the scene changes while the dialog shows a result.
  const validation = useMemo(() => {
    if (!result?.fragment) return null;
    try {
      const normalized = normalizeFragment(result.fragment);
      return { normalized, ...validateFragment(normalized, scene) };
    } catch (e) {
      return { normalized: null, errors: [`Fragment validation crashed: ${e.message}`], warnings: [] };
    }
  }, [result, scene]);

  const addFiles = async (files) => {
    for (const file of files) {
      try {
        const payload = await fileToImagePayload(file);
        setImages(prev => (prev.length >= 4 ? prev : [...prev, payload]));
      } catch (e) {
        setResult({ error: e.message });
      }
    }
  };

  const onPaste = (e) => {
    const files = [...(e.clipboardData?.items || [])]
      .filter(it => it.kind === 'file' && it.type.startsWith('image/'))
      .map(it => it.getAsFile())
      .filter(Boolean);
    if (files.length > 0) { e.preventDefault(); addFiles(files); }
  };

  const onDrop = (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files || [])].filter(f => f.type.startsWith('image/'));
    if (files.length > 0) addFiles(files);
  };

  const canGenerate = !busy && settings.apiKey.trim() && (prompt.trim() || images.length > 0);

  const generate = async () => {
    if (!canGenerate) return;
    setBusy(true);
    setResult(null);
    try {
      const system = buildSystemPrompt(scene, prefix, paramValues);
      const r = await requestGeometry({
        apiKey: settings.apiKey.trim(),
        model: settings.model,
        userText: prompt,
        images,
        system,
      });
      setResult(r);
    } catch (e) {
      setResult({ error: e.message });
    } finally {
      setBusy(false);
    }
  };

  const insert = () => {
    if (!result?.fragment || !validation || validation.errors.length > 0) return;
    onApply(result.fragment);
    setResult(null);
    setPrompt('');
    setImages([]);
    onClose();
  };

  const fragSummary = validation?.normalized && (() => {
    const f = validation.normalized;
    const bits = [`${f.components.length} component${f.components.length === 1 ? '' : 's'}`];
    if (f.params.length) bits.push(`${f.params.length} param${f.params.length === 1 ? '' : 's'}`);
    if (f.snaps.length) bits.push(`${f.snaps.length} snap${f.snaps.length === 1 ? '' : 's'}`);
    return bits.join(' · ');
  })();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(2,6,23,0.8)' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-[640px] max-w-[94vw] max-h-[90vh] flex flex-col rounded-lg border border-slate-700 shadow-2xl"
        style={{ background: '#0f172a' }}
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-700">
          <Sparkles size={15} className="text-violet-400" />
          <span className="text-sm font-semibold text-slate-100">AI geometry assistant</span>
          <span className="text-[10px] text-slate-500 font-mono">new ids prefixed {prefix}_*</span>
          <button onClick={onClose} className="ml-auto text-slate-400 hover:text-slate-200" aria-label="Close">
            <XIcon size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {/* Settings */}
          <div className="rounded border border-slate-800 px-3 py-2 space-y-2" style={{ background: 'rgba(30,41,59,0.5)' }}>
            <p className="text-[10px] uppercase tracking-wider text-slate-500">Claude account settings</p>
            <div className="flex items-center gap-2">
              <label className="text-[11px] text-slate-400 w-16 flex-shrink-0">API key</label>
              <div className="flex-1 flex items-center gap-1">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={settings.apiKey}
                  onChange={(e) => updateSettings({ apiKey: e.target.value })}
                  placeholder="sk-ant-…  (console.anthropic.com → API keys)"
                  autoComplete="off"
                  spellCheck={false}
                  className="flex-1 px-2 py-1 rounded text-xs font-mono bg-slate-900 border border-slate-700 text-slate-200 focus:border-violet-500 outline-none"
                />
                <button
                  onClick={() => setShowKey(s => !s)}
                  className="text-slate-500 hover:text-slate-300 p-1"
                  title={showKey ? 'Hide key' : 'Show key'}
                >
                  {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-[11px] text-slate-400 w-16 flex-shrink-0">Model</label>
              <select
                value={settings.model}
                onChange={(e) => updateSettings({ model: e.target.value })}
                className="flex-1 px-2 py-1 rounded text-xs bg-slate-900 border border-slate-700 text-slate-200 focus:border-violet-500 outline-none"
              >
                {AI_MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </div>
            <p className="text-[10px] text-slate-500 leading-snug">
              The key is stored only in this browser&apos;s local storage and sent only to api.anthropic.com.
              It is never included in saved designs, workspace exports, or generated scripts.
            </p>
          </div>

          {/* Prompt + images */}
          <div className="space-y-2">
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onPaste={onPaste}
              rows={4}
              placeholder={'Describe the structure to add — e.g. "a CPW with 80 um signal width, 12 um gaps, 300 um grounds, 2 mm long, with a lumped port at the left end". Attach or paste a sketch for anything geometric. All dimensions come back as sweepable parameters.'}
              className="w-full px-2.5 py-2 rounded text-xs bg-slate-900 border border-slate-700 text-slate-200 focus:border-violet-500 outline-none resize-y leading-relaxed"
            />
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1 px-2 py-1 rounded text-[11px] border border-slate-700 text-slate-300 hover:border-violet-500 hover:text-violet-300"
                title="Attach sketch images (or paste / drag-drop onto the dialog)"
              >
                <ImagePlus size={12} /> attach sketch
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                multiple
                className="hidden"
                onChange={(e) => { addFiles([...e.target.files]); e.target.value = ''; }}
              />
              {images.map((img, i) => (
                <div key={i} className="relative group">
                  <img
                    src={img.previewUrl}
                    alt={img.name}
                    className="h-12 w-12 object-cover rounded border border-slate-700"
                  />
                  <button
                    onClick={() => setImages(prev => prev.filter((_, j) => j !== i))}
                    className="absolute -top-1.5 -right-1.5 bg-slate-800 border border-slate-600 rounded-full p-0.5 text-slate-400 hover:text-red-400 opacity-0 group-hover:opacity-100"
                    aria-label={`Remove ${img.name}`}
                  >
                    <XIcon size={9} />
                  </button>
                </div>
              ))}
              <button
                onClick={generate}
                disabled={!canGenerate}
                className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium disabled:opacity-30 disabled:cursor-not-allowed"
                style={{ background: '#7c3aed', color: 'white' }}
                title={!settings.apiKey.trim() ? 'Add your Anthropic API key above first' : 'Generate geometry'}
              >
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                {busy ? 'generating…' : 'generate'}
              </button>
            </div>
          </div>

          {/* Result */}
          {result?.error && (
            <div className="rounded border border-red-900 px-3 py-2 text-xs text-red-300 flex items-start gap-2" style={{ background: 'rgba(127,29,29,0.2)' }}>
              <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
              <span>{result.error}</span>
            </div>
          )}
          {result && !result.error && !result.fragment && (
            <div className="rounded border border-amber-900 px-3 py-2 text-xs text-amber-200 whitespace-pre-wrap" style={{ background: 'rgba(120,53,15,0.15)' }}>
              {result.message}
            </div>
          )}
          {result?.fragment && validation && (
            <div className="rounded border border-slate-700 px-3 py-2 space-y-2" style={{ background: 'rgba(30,41,59,0.5)' }}>
              <div className="flex items-center gap-2">
                <Check size={13} className={validation.errors.length === 0 ? 'text-emerald-400' : 'text-slate-600'} />
                <span className="text-xs text-slate-200 font-medium">{fragSummary}</span>
                {result.message && <span className="text-[10px] text-slate-500 truncate">{result.message}</span>}
              </div>
              {validation.normalized && validation.normalized.params.length > 0 && (
                <p className="text-[10px] text-slate-400 font-mono leading-relaxed">
                  {validation.normalized.params.map(p => `${p.name}=${p.expr}`).join('  ·  ')}
                </p>
              )}
              {validation.errors.map((e, i) => (
                <p key={`e${i}`} className="text-[11px] text-red-400 flex items-start gap-1.5">
                  <AlertTriangle size={11} className="flex-shrink-0 mt-0.5" /> {e}
                </p>
              ))}
              {validation.warnings.map((w, i) => (
                <p key={`w${i}`} className="text-[11px] text-amber-400/80">{w}</p>
              ))}
              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={insert}
                  disabled={validation.errors.length > 0}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium disabled:opacity-30 disabled:cursor-not-allowed"
                  style={{ background: '#059669', color: 'white' }}
                  title="Insert at the viewport center (single undo step)"
                >
                  <Check size={13} /> insert into canvas
                </button>
                <span className="text-[10px] text-slate-500">
                  {validation.errors.length > 0
                    ? 'Fix by rephrasing and regenerating — invalid fragments are never inserted.'
                    : `Knobs land in PARAMS as ${prefix}_*; undo with ⌘Z.`}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
