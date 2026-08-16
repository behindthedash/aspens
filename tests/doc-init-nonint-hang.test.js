import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { spawn, execSync } from 'child_process';
import { join } from 'path';

const CLI = join(import.meta.dirname, '..', 'bin', 'cli.js');
const FIXTURE_DIR = join(import.meta.dirname, 'tmp-nonint-hang-fixture');
const BOUND_MS = 15000; // generous ceiling; a fixed run must finish well under it

// Mirrors src/lib/backend.js's own detection (a lightweight `--version`
// check) — test-local, no production code touched. Neither test needs a
// real backend to be authenticated, only present on PATH: `doc init` starts
// generation (and hangs, pre-fix) before ever making a network call.
function detectFirstAvailableBackend() {
  for (const [id, cmd] of [['claude', 'claude'], ['codex', 'codex'], ['opencode', 'opencode']]) {
    try {
      execSync(`${cmd} --version`, { stdio: 'pipe', timeout: 10000 });
      return id;
    } catch { /* not installed */ }
  }
  return null;
}
const AVAILABLE_BACKEND = detectFirstAvailableBackend();

beforeEach(() => {
  if (existsSync(FIXTURE_DIR)) rmSync(FIXTURE_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURE_DIR, { recursive: true });
  // Existing Claude + Codex docs so hasExistingDocs=true and the
  // reuse-domains confirm (doc-init.js:434) is the one actually reached.
  writeFileSync(join(FIXTURE_DIR, 'CLAUDE.md'), '# fixture\n', 'utf8');
  writeFileSync(join(FIXTURE_DIR, 'AGENTS.md'), '# fixture\n', 'utf8');
});

afterAll(() => {
  if (existsSync(FIXTURE_DIR)) rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

// Spawns the CLI with stdin left as a genuinely open, never-written,
// never-closed pipe — the exact shape of worktrail's real caller
// (Python's `subprocess.run(cmd, capture_output=True)` with no `input=`).
// This is NOT the same as stdin redirected from /dev/null: a closed/EOF
// stdin resolves @clack/prompts immediately, but an open pipe with no data
// and no EOF is what actually reproduces the reported indefinite hang.
function runWithOpenStdin(args) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: FIXTURE_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolvePromise({ timedOut: true, code: null, stdout, stderr });
    }, BOUND_MS);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolvePromise({ timedOut: false, code, stdout, stderr });
    });
    // Deliberately never call child.stdin.end() or write() here.
  });
}

describe('doc init — non-interactive stdin never hangs', () => {
  // Both cases need at least one backend CLI present on PATH to get past
  // Step 0's own "no backend installed" check and actually reach the
  // prompt sites this fix guards — stock CI (no claude/codex/opencode
  // installed) skips them rather than failing on an unrelated missing
  // binary. Neither reads network/auth: a bare `--version` success is
  // enough, since generation is asserted to *start*, never to complete.
  it.skipIf(!AVAILABLE_BACKEND)('resolves the reuse-domains confirm via --yes instead of hanging', async () => {
    const { timedOut, stdout } = await runWithOpenStdin([
      'doc', 'init', '--target', AVAILABLE_BACKEND, '--backend', AVAILABLE_BACKEND,
      '--no-hook', '--timeout', '2', '--yes',
    ]);

    // --yes resolves the reuse-domains confirm (and every other prompt in
    // this run) without ever rendering it, so the run reaches real
    // generation instead of blocking on the confirm forever.
    expect(timedOut).toBe(false);
    expect(stdout).toContain('Generating');
  }, BOUND_MS + 3000);

  it.skipIf(!AVAILABLE_BACKEND)('fails fast with a clear error instead of hanging when no flag resolves the choice', async () => {
    const { timedOut, code, stderr } = await runWithOpenStdin(['doc', 'init']);

    expect(timedOut).toBe(false);
    expect(code).not.toBe(0);
    expect(stderr).toContain('non-interactive session');
  }, BOUND_MS + 3000);
});
