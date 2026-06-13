// AI geometry assistant — Anthropic API client (browser-side).
//
// The request goes STRAIGHT from the user's browser to the Anthropic API
// with the user's own key (`dangerouslyAllowBrowser` sets the
// anthropic-dangerous-direct-browser-access header that makes the API
// accept CORS calls). No proxy, no server, the key never leaves the
// machine except to api.anthropic.com.
//
// Contract: one user turn (text + optional sketch images) → either
//   { fragment, message }  — Claude called emit_geometry (message = its
//                            accompanying prose, usually empty), or
//   { fragment: null, message } — Claude needs clarification; message is
//                            its question, surfaced verbatim in the UI.
// API/auth errors throw with a UI-ready message.

import { GEOMETRY_TOOL } from './assistant.js';

// The Anthropic SDK is dynamically imported on first use so it lives in
// its own lazy chunk — users who never open the assistant never load it.
let _anthropic = null;
async function getAnthropic() {
  if (!_anthropic) _anthropic = (await import('@anthropic-ai/sdk')).default;
  return _anthropic;
}

export const AI_MODELS = [
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8 (recommended)' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (faster, cheaper)' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (fastest, simple shapes)' },
];
export const DEFAULT_AI_MODEL = 'claude-opus-4-8';

// Haiku 4.5 predates adaptive thinking; sending the param there 400s.
const supportsAdaptiveThinking = (model) => !/haiku/.test(model);

export async function requestGeometry({ apiKey, model, userText, images = [], system }) {
  const Anthropic = await getAnthropic();
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  const content = [
    ...images.map(img => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.data },
    })),
    {
      type: 'text',
      text: userText && userText.trim()
        ? userText.trim()
        : 'Generate the geometry shown in the attached sketch.',
    },
  ];

  let response;
  try {
    // Stream (not .create) and give a generous output budget: with adaptive
    // thinking ON, reasoning tokens count against max_tokens, so a complex
    // request can exhaust a small budget BEFORE the emit_geometry tool call
    // is produced — yielding a response with only a (truncated) thinking
    // block, no tool_use, no text. Streaming also avoids the SDK HTTP
    // timeout at high max_tokens. 32k leaves ample room for thinking + a
    // sizeable geometry fragment; Opus/Sonnet/Haiku all allow >= 64k output.
    const stream = client.messages.stream({
      model,
      max_tokens: 32000,
      ...(supportsAdaptiveThinking(model) ? { thinking: { type: 'adaptive' } } : {}),
      system,
      tools: [GEOMETRY_TOOL],
      messages: [{ role: 'user', content }],
    });
    response = await stream.finalMessage();
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new Error('Invalid API key — check the key in the assistant settings (it should start with sk-ant-).', { cause: err });
    }
    if (err instanceof Anthropic.PermissionDeniedError) {
      throw new Error(`This API key does not have access to ${model}. Pick another model or check your Anthropic console.`, { cause: err });
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new Error('Rate limited by the Anthropic API — wait a moment and try again.', { cause: err });
    }
    if (err instanceof Anthropic.APIError) {
      throw new Error(`Anthropic API error (${err.status}): ${err.message}`, { cause: err });
    }
    throw new Error(`Request failed: ${err.message}`, { cause: err });
  }

  const toolUse = (response.content || []).find(
    b => b.type === 'tool_use' && b.name === GEOMETRY_TOOL.name,
  );
  const message = (response.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();

  if (toolUse && toolUse.input && Array.isArray(toolUse.input.components)) {
    return { fragment: toolUse.input, message };
  }

  // No usable fragment. Turn stop_reason into an actionable explanation
  // instead of a dead-end "no geometry" message — the most common cause is
  // the model running out of output budget mid-reasoning on a complex
  // request, which is otherwise invisible to the user.
  const stop = response.stop_reason;
  if (stop === 'max_tokens') {
    return {
      fragment: null,
      message: toolUse
        ? 'Claude started emitting geometry but hit the output token limit before finishing it. Try a simpler / more specific request, or switch to Sonnet or Haiku (they reason less, leaving more budget for the geometry).'
        : 'Claude ran out of output budget while reasoning about this request and never produced geometry. Try a simpler or more specific description, or switch to Sonnet or Haiku in the model dropdown.',
    };
  }
  if (stop === 'refusal') {
    return { fragment: null, message: message || 'Claude declined to generate this geometry. Rephrase the request.' };
  }
  return {
    fragment: null,
    message: message
      || `Claude returned no geometry and no explanation (stop reason: ${stop || 'unknown'}) — try rephrasing the request.`,
  };
}

// ---------------------------------------------------------------------------
// Image intake: File/Blob → base64 payload, downscaled to the API's
// useful ceiling (1568 px long edge — larger is resized server-side
// anyway, so shipping more is pure upload weight).
// ---------------------------------------------------------------------------

const MAX_IMAGE_EDGE = 1568;

export async function fileToImagePayload(file) {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
    throw new Error(`Unsupported image type "${file.type}" — use PNG, JPEG, WebP, or GIF.`);
  }
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  // Sketches are usually dark strokes on transparency or paper — flatten
  // onto white so transparent PNGs don't turn into black rectangles.
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, w, h);
  g.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const dataUrl = canvas.toDataURL('image/png');
  return {
    mediaType: 'image/png',
    data: dataUrl.slice(dataUrl.indexOf(',') + 1),
    name: file.name || 'sketch',
    previewUrl: dataUrl,
  };
}
