import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { installStorageShim } from './storage/window-storage-shim.js'
import { hydrateTwoLinePrefs } from './ui/twoLineSettings.js'

// Provide an IndexedDB-backed `window.storage` (falling back to
// localStorage, then memory) when the host doesn't supply its own.
// Must run before React mounts so the first effect in App (load the
// last-used workspace) sees a working storage backend. The backend opens
// lazily on first use, so this call stays synchronous.
installStorageShim();

// Warm the 2-line wizard's last-used field values from the durable store
// (IndexedDB) into its in-memory cache, so a fresh reload restores them even
// when localStorage is blocked. Fire-and-forget — finishes well before the
// user can navigate Export → 2-line method.
hydrateTwoLinePrefs();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
