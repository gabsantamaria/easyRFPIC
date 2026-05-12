import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { installLocalStorageShim } from './storage/window-storage-shim.js'

// Provide a localStorage-backed `window.storage` when the host doesn't
// supply its own implementation. Must run before React mounts so the
// first effect in App (load the last-used workspace) sees a working
// storage backend.
installLocalStorageShim();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
