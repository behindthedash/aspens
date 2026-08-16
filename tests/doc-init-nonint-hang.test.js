import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';

const CLI = join(import.meta.dirname, '..', 'bin', 'cli.js');
const FIXTURE_DIR = join(import.meta.dirname, 'tmp-nonint-hang-fixture');
const BOUND_MS = 15000; // generous ceiling; a fixed run must finish well under it

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
  it('resolves the reuse-domains confirm via --yes instead of hanging', async () => {
    const { timedOut, stdout } = await runWithOpenStdin([
      'doc', 'init', '--target', 'claude', '--backend', 'claude',
      '--no-hook', '--timeout', '2', '--yes',
    ]);

    // --yes resolves the reuse-domains confirm (and every other prompt in
    // this run) without ever rendering it, so the run reaches real
    // generation instead of blocking on the confirm forever.
    expect(timedOut).toBe(false);
    expect(stdout).toContain('Generating');
  }, BOUND_MS + 3000);

  it('fails fast with a clear error instead of hanging when no flag resolves the choice', async () => {
    const { timedOut, code, stderr } = await runWithOpenStdin(['doc', 'init']);

    expect(timedOut).toBe(false);
    expect(code).not.toBe(0);
    expect(stderr).toContain('non-interactive session');
  }, BOUND_MS + 3000);
});
