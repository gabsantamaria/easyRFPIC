import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { installStorageShim } from './storage/window-storage-shim.js'

// Provide an IndexedDB-backed `window.storage` (falling back to
// localStorage, then memory) when the host doesn't supply its own.
// Must run before React mounts so the first effect in App (load the
// last-used workspace) sees a working storage backend. The backend opens
// lazily on first use, so this call stays synchronous.
installStorageShim();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
