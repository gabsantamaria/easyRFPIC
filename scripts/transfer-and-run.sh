#!/usr/bin/env bash
# Transfer the Claude worktree's branch into main in the parent repo,
# install dependencies if needed, run the full test suite (vitest +
# legacy node-script tests), build, and launch the dev server.
#
# Safe to re-run after the merge has already happened — every step
# either fast-forwards a zero-distance branch (no-op), runs an
# idempotent command (npm install on a satisfied lockfile is fast),
# or re-runs the test suite. The script bails before doing anything
# destructive if the parent repo has uncommitted changes or isn't
# on `main`.
#
# Usage:
#   bash scripts/transfer-and-run.sh
# from anywhere — the script cd's to the parent repo on its own.

set -euo pipefail

PARENT="/Users/gab/PICLab Dropbox/Instrumentation Code Base/photonic-layout"
BRANCH="claude/stupefied-nobel-f15a8d"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

step "cd $PARENT"
cd "$PARENT"

CURRENT_BRANCH="$(git branch --show-current)"
echo "    parent repo branch: $CURRENT_BRANCH"

if [ "$CURRENT_BRANCH" != "main" ]; then
  fail "parent repo is on '$CURRENT_BRANCH', not 'main'. Switch with: git switch main"
fi

# Bail on dirty working tree. Untracked files are OK (the worktree
# itself and Claude's session metadata live in .claude/ which is
# already gitignored).
if ! git diff-index --quiet HEAD --; then
  echo
  git status --short
  fail "parent repo has uncommitted changes. Commit or stash them first."
fi

if ! git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  echo "available local branches:"
  git branch
  fail "branch '$BRANCH' doesn't exist in this repo."
fi

AHEAD="$(git rev-list --count "main..$BRANCH")"

if [ "$AHEAD" -eq 0 ]; then
  step "main is already at the tip of $BRANCH ($AHEAD commits ahead) — skipping merge"
else
  step "fast-forwarding main by $AHEAD commits from $BRANCH"
  git merge --ff-only "$BRANCH"
fi

step "npm install"
npm install

step "npm test (vitest)"
npm test

step "npm run build"
npm run build

step "legacy node-script tests"
node tests/test_drag_thorough.mjs
node tests/test_shapes.mjs
node tests/test_racetrack.mjs
node tests/test_racetrack_export.mjs
node tests/regen.mjs

step "starting dev server — Ctrl-C to stop"
exec npm run dev
