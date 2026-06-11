// AI assistant settings — API key + model choice.
//
// Stored ONLY in the browser's localStorage under a key that is NOT one
// of the workspace storage prefixes, so the API key can never ride along
// in a design export, a workspace export/import bundle, or a generated
// script. Clearing browser site data removes it.

import { DEFAULT_AI_MODEL } from './client.js';

const SETTINGS_KEY = 'photonic_layout_ai_settings';

export function loadAiSettings() {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { apiKey: '', model: DEFAULT_AI_MODEL };
    const parsed = JSON.parse(raw);
    return {
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      model: typeof parsed.model === 'string' && parsed.model ? parsed.model : DEFAULT_AI_MODEL,
    };
  } catch {
    return { apiKey: '', model: DEFAULT_AI_MODEL };
  }
}

export function saveAiSettings({ apiKey, model }) {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      apiKey: apiKey || '',
      model: model || DEFAULT_AI_MODEL,
    }));
    return true;
  } catch {
    return false;
  }
}
