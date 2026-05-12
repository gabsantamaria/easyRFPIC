// Codify a library-item payload as a built-in template module source.
//
// Output is a complete JS file ready to drop under src/templates/. The
// generated module imports the shared insertLibraryPayload helper so it
// stays in lock-step with the live library-insert behavior — no risk of
// the codified version drifting from how the same scene gets inserted
// from localStorage.
//
// Returns { filename, source }. The caller is responsible for actually
// triggering the download (the host might be in a sandboxed iframe etc.).

export function generateTemplateModuleSource({ payload, name, description }) {
  const safeName  = sanitizeFilename(name);
  const safeIdent = sanitizeIdentifier(name);
  const id        = `builtin_${safeIdent}`;
  const desc      = description
    || `Saved from library item "${name}" on ${new Date().toISOString().slice(0, 10)}.`;
  const payloadJson = JSON.stringify(payload, null, 2);
  const source = `// Auto-generated built-in template from library item "${escapeForComment(name)}".
//
// Drop this file under src/templates/, then add it to BUILTIN_TEMPLATES
// in src/templates/index.js to make it appear in the Library panel:
//
//     import ${safeIdent} from './${safeName}.js';
//     export const BUILTIN_TEMPLATES = [racetrack, ringResonator, ${safeIdent}];
//
// The payload is the exact library snapshot at codify time; editing it
// here changes the template, but won't sync back to the original
// library entry.
import { insertLibraryPayload } from './_library-insert.js';

const PAYLOAD = ${payloadJson};

export default {
  id: ${JSON.stringify(id)},
  name: ${JSON.stringify(name)},
  description: ${JSON.stringify(desc)},
  insert: (prev, ctx) => insertLibraryPayload(prev, ctx, PAYLOAD),
};
`;
  return { filename: `${safeName}.js`, source };
}

// File-system-safe filename: lowercase, [a-z0-9_-]+, single dashes/underscores.
function sanitizeFilename(name) {
  const s = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9_\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return s || 'template';
}

// Valid JS identifier: starts with letter / _, then [A-Za-z0-9_]*.
function sanitizeIdentifier(name) {
  let s = String(name).replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!s) s = 'template';
  if (/^[0-9]/.test(s)) s = `_${s}`;
  return s;
}

function escapeForComment(s) {
  return String(s).replace(/\*\//g, '*\\/');
}
