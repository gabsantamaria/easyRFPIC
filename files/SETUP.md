# Setup — exact steps

You only need to do this once. After that, see `FIRST_TASKS.md` for what to run in Claude Code.

## Prerequisites

- Node.js ≥ 18 (`node --version` to check). If not installed: `brew install node` on macOS, or download from nodejs.org.
- Python 3 (for parse-checking exports). Usually already installed.
- Git (`git --version` to check).
- Claude Code installed. If not: `npm install -g @anthropic-ai/claude-code`.

## 1. Pick a directory

```bash
mkdir -p ~/projects/photonic-layout
cd ~/projects/photonic-layout
```

(Use whatever directory you prefer — this is just an example.)

## 2. Scaffold a Vite + React project

```bash
npm create vite@latest . -- --template react
npm install
```

When Vite asks "Current directory is not empty. Please choose how to proceed:", pick **Ignore files and continue**.

## 3. Install the libraries the layout tool uses

```bash
npm install lucide-react recharts
npm install -D tailwindcss @tailwindcss/vite
npm install -D @babel/parser
```

## 4. Configure Tailwind

Edit `vite.config.js` to add the Tailwind plugin:

```js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
})
```

Replace `src/index.css` (or whatever Vite created) with:

```css
@import "tailwindcss";
```

## 5. Drop in the bootstrap files

Copy these from this bundle into your project root:

```
CLAUDE.md
README.md
PROPOSED_STRUCTURE.md
FIRST_TASKS.md
.gitignore
tests/  (entire directory)
```

Copy the existing `PhotonicLayout.jsx` (the ~11k-line file we've been working on) to `src/PhotonicLayout.jsx`.

## 6. Wire it up

Replace `src/App.jsx` with:

```jsx
import PhotonicLayout from './PhotonicLayout.jsx';
export default function App() { return <PhotonicLayout />; }
```

You can delete `src/App.css` if you want.

## 7. Run it once to confirm it works

```bash
npm run dev
```

Open the URL Vite prints. You should see the layout tool. If anything is broken, fix it now BEFORE committing or running Claude Code — you want the baseline to work.

## 8. Initialize git

```bash
git init
git add .
git commit -m "Initial commit: PhotonicLayout monolith + bootstrap docs"
```

## 9. Start Claude Code

```bash
claude
```

When it starts, paste the prompt from `FIRST_TASKS.md` step 1. Then proceed through the tasks in order.

## Troubleshooting

**"Module not found: lucide-react"** — `npm install lucide-react` again, make sure you're in the project root.

**Tailwind classes not applying** — confirm `index.css` has `@import "tailwindcss";` and that it's imported in `src/main.jsx`.

**Parse error on PhotonicLayout.jsx** — the file uses modern React (hooks, JSX). Vite handles this out of the box, so a parse error means the file got corrupted in transit. Re-copy from the original.

**Tests fail with "Cannot find module"** — the tests import the source file relatively. They live in `tests/` and expect `src/PhotonicLayout.jsx` to exist. Check the path in `tests/regen.mjs`.
