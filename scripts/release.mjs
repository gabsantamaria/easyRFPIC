#!/usr/bin/env node
// Bump the patch version and tag a release. The GitHub Pages workflow
// (.github/workflows/deploy.yml) fires on `v*` tag pushes, so a single
// `npm run release` ships whatever's currently on `main`.
//
//   npm run release           → vX.Y.(Z+1)   ← default, patch bump
//   npm run release -- --minor → vX.(Y+1).0
//   npm run release -- --major → v(X+1).0.0
//
// Run from anywhere inside the repo. Catches the common foot-guns:
//   - uncommitted changes → refuse (would tag stale state)
//   - HEAD not on main → fast-forward main to HEAD first (handles the
//     worktree-branch case where claude/* is ahead of main)
//   - local main behind origin/main → pull --ff-only
//   - non-fast-forward divergence → refuse with a clear message
//   - tag already exists on remote → suggest the next available
//
// Logs the workflow URL + the live page URL at the end so you can
// jump straight to the Actions tab while the deploy runs.
import { execSync } from 'child_process';
import { existsSync } from 'fs';

const ARGS = process.argv.slice(2);
const BUMP = ARGS.includes('--major') ? 'major'
           : ARGS.includes('--minor') ? 'minor'
           : 'patch';
// --dry-run: print what would happen but don't update refs, tag, or push.
// Useful for sanity-checking the bump target on a complicated state.
const DRY_RUN = ARGS.includes('--dry-run') || ARGS.includes('-n');

function sh(cmd, { stdio = 'pipe', okFail = false } = {}) {
  try {
    return execSync(cmd, { stdio: stdio === 'pipe' ? ['pipe', 'pipe', 'pipe'] : stdio })
      .toString()
      .trim();
  } catch (e) {
    if (okFail) return '';
    throw e;
  }
}

function inheritSh(cmd) {
  return execSync(cmd, { stdio: 'inherit' });
}

function fail(msg) {
  console.error('\x1b[31m✗\x1b[0m ' + msg);
  process.exit(1);
}

function info(msg) {
  console.log('\x1b[36mℹ\x1b[0m ' + msg);
}

function ok(msg) {
  console.log('\x1b[32m✓\x1b[0m ' + msg);
}

// ──────────────────────────────────────────────────────────────────────
// 1. Sanity: are we in a git repo?
// ──────────────────────────────────────────────────────────────────────
const gitDir = sh('git rev-parse --git-dir', { okFail: true });
if (!gitDir) fail('Not inside a git repository.');

// 2. Uncommitted changes block the release.
const dirty = sh('git status --porcelain');
if (dirty) {
  console.error('Working tree has uncommitted changes:');
  console.error(dirty);
  fail('Commit or stash them before releasing.');
}

// 3. Make sure we have current remote state (tags + branches).
info('Fetching origin (branches + tags)…');
inheritSh('git fetch origin --tags --prune --prune-tags');

// 4. What does origin look like?
const remoteUrl = sh('git remote get-url origin', { okFail: true });
if (!remoteUrl) fail('No `origin` remote configured.');
const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/i);
const repoUser = match?.[1];
const repoName = match?.[2];

// 5. Resolve the latest semver tag (across local + remote, after the
//    fetch above local tags should already include everything). The
//    'v*' glob is QUOTED so the shell doesn't try to expand it against
//    files in cwd — without the quotes you get an empty tag list.
const tagList = sh("git tag --list 'v*'")
  .split('\n')
  .map(t => t.trim())
  .filter(t => /^v\d+\.\d+\.\d+$/.test(t));
tagList.sort((a, b) => {
  const [aa, bb] = [a, b].map(t => t.slice(1).split('.').map(Number));
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] - bb[i];
  return 0;
});
const latest = tagList[tagList.length - 1] || null;
let [major, minor, patch] = latest ? latest.slice(1).split('.').map(Number) : [0, 0, 0];
if (BUMP === 'major') { major++; minor = 0; patch = 0; }
else if (BUMP === 'minor') { minor++; patch = 0; }
else { patch++; }
let newTag = `v${major}.${minor}.${patch}`;

// 6. If the bumped tag somehow already exists (e.g. someone tagged
//    out-of-band), keep bumping the patch until we find a free slot.
//    Avoids the user manually deleting + force-pushing tags.
while (tagList.includes(newTag)) {
  patch++;
  newTag = `v${major}.${minor}.${patch}`;
}
info(`Latest tag: ${latest || '(none)'}`);
info(`Bumping ${BUMP} → \x1b[33m${newTag}\x1b[0m`);

// 7. Get main in shape: if HEAD is ahead of main (typical when the
//    user has been developing on a worktree branch), fast-forward
//    main to HEAD. If main is behind origin/main, pull. If diverged
//    in either direction we can't auto-reconcile, so refuse.
const headSha = sh('git rev-parse HEAD');
const mainSha = sh('git rev-parse refs/heads/main', { okFail: true });
const originMainSha = sh('git rev-parse refs/remotes/origin/main', { okFail: true });

// 7a. Main vs HEAD.
if (mainSha && mainSha !== headSha) {
  // Is main an ancestor of HEAD? (HEAD ahead of main → safe fast-forward)
  const mainIsAncestor = sh(`git merge-base --is-ancestor ${mainSha} HEAD; echo $?`, { okFail: true }).split('\n').pop() === '0';
  // Actually simpler: just try the ff-only update.
  // git update-ref is the worktree-safe way to advance main without
  // needing to `git checkout main` (which fails inside a non-main worktree).
  // We only do it if main is strictly ancestor of HEAD.
  if (mainIsAncestor) {
    info(`Fast-forwarding main to HEAD (${mainSha.slice(0, 7)} → ${headSha.slice(0, 7)})${DRY_RUN ? ' [dry-run, skipped]' : '…'}`);
    if (!DRY_RUN) sh(`git update-ref refs/heads/main ${headSha}`);
  } else {
    fail(`HEAD (${headSha.slice(0,7)}) is not a fast-forward of main (${mainSha.slice(0,7)}). Reconcile manually.`);
  }
}

// 7b. Local main vs origin/main.
const localMain = sh('git rev-parse refs/heads/main');
if (originMainSha && originMainSha !== localMain) {
  const aheadOfOrigin = parseInt(sh(`git rev-list --count origin/main..refs/heads/main`) || '0', 10);
  const behindOrigin = parseInt(sh(`git rev-list --count refs/heads/main..origin/main`) || '0', 10);
  if (aheadOfOrigin > 0 && behindOrigin > 0) {
    fail(`Local main and origin/main have diverged (${aheadOfOrigin} ahead, ${behindOrigin} behind). Reconcile manually.`);
  } else if (behindOrigin > 0) {
    info(`origin/main has ${behindOrigin} new commits — pulling${DRY_RUN ? ' [dry-run, skipped]' : '…'}`);
    if (!DRY_RUN) {
      inheritSh('git fetch origin main');
      // We're potentially not ON main, so use update-ref again instead of
      // a plain `git pull` (which acts on the checked-out branch).
      const newOriginMain = sh('git rev-parse refs/remotes/origin/main');
      sh(`git update-ref refs/heads/main ${newOriginMain}`);
    }
  }
  // aheadOfOrigin > 0 case: handled by the push below.
}

// 8. Push main first, then the tag — order matters because the
//    workflow checks out the tag, and the tag's commit needs to be
//    reachable from origin/main.
if (DRY_RUN) {
  info(`[dry-run] would push main: ${sh('git rev-parse refs/heads/main').slice(0, 7)} → origin/main`);
  info(`[dry-run] would tag ${newTag} at refs/heads/main`);
  info(`[dry-run] would push tag ${newTag} to origin`);
} else {
  info('Pushing main to origin…');
  inheritSh('git push origin refs/heads/main:refs/heads/main');

  info(`Tagging ${newTag} at refs/heads/main…`);
  sh(`git tag ${newTag} refs/heads/main`);

  info(`Pushing tag ${newTag}…`);
  inheritSh(`git push origin refs/tags/${newTag}`);
}

// 9. Wrap up: print the URLs the user actually cares about.
console.log();
ok(`${DRY_RUN ? '[dry-run] would have released' : 'Released'} \x1b[33m${newTag}\x1b[0m`);
if (repoUser && repoName) {
  console.log(`  Actions:  https://github.com/${repoUser}/${repoName}/actions`);
  console.log(`  Live URL: https://${repoUser}.github.io/${repoName}/  (after deploy finishes, ~60–90s)`);
} else {
  console.log(`  (Couldn't parse origin URL "${remoteUrl}" to build links.)`);
}
