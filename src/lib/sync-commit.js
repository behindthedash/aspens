import { execFileSync } from 'child_process';
import { relative, join } from 'path';

export const SYNC_COMMIT_MESSAGE = 'docs(aspens): sync generated docs';

/**
 * Stage and commit the files `doc sync` just wrote so the regenerated docs
 * land on the current branch instead of sitting as an uncommitted diff in
 * the checkout (and in every linked worktree that shares the hook).
 *
 * Only the given paths are staged — nothing else in the working tree is
 * touched. `--no-verify` skips pre-commit/commit-msg hooks (a docs-only
 * commit has nothing for them to check), and the post-commit hook that runs
 * afterwards sees an aspens-only commit and returns early, so no loop.
 *
 * @param {string} gitRoot   git top-level directory
 * @param {string} repoPath  project directory the paths are relative to
 * @param {string[]} paths   project-relative files that were written
 * @returns {{ committed: boolean, sha?: string, error?: string }}
 */
export function commitSyncOutput(gitRoot, repoPath, paths) {
  const gitPaths = paths.map(p => relative(gitRoot, join(repoPath, p)).split('\\').join('/'));
  if (gitPaths.length === 0) return { committed: false, error: 'nothing to commit' };
  const opts = { cwd: gitRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
  try {
    execFileSync('git', ['add', '--', ...gitPaths], opts);
    const staged = execFileSync('git', ['diff', '--cached', '--name-only', '--', ...gitPaths], opts).trim();
    if (!staged) return { committed: false, error: 'nothing to commit' };
    execFileSync('git', ['commit', '--quiet', '--no-verify', '-m', SYNC_COMMIT_MESSAGE, '--', ...gitPaths], opts);
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], opts).trim();
    return { committed: true, sha };
  } catch (err) {
    const detail = (err.stderr || err.message || '').toString().trim().split('\n')[0];
    return { committed: false, error: detail || 'git commit failed' };
  }
}
