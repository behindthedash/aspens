import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';

const CLI = join(import.meta.dirname, '..', 'bin', 'cli.js');
const FIXTURE_DIR = join(import.meta.dirname, 'tmp-nonint-hang-remaining-fixture');
const BOUND_MS = 15000; // generous ceiling; a fixed run must finish well under it

beforeEach(() => {
  if (existsSync(FIXTURE_DIR)) rmSync(FIXTURE_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURE_DIR, { recursive: true });
});

afterAll(() => {
  if (existsSync(FIXTURE_DIR)) rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

// Spawns the CLI with stdin left as a genuinely open, never-written,
// never-closed pipe — the exact shape of worktrail's real caller
// (Python's `subprocess.run(cmd, capture_output=True)` with no `input=`).
// See doc-init-nonint-hang.test.js for why an open pipe (not /dev/null) is
// required to reproduce the hang.
function runWithOpenStdin(args, cwd = FIXTURE_DIR) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
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

// Like runWithOpenStdin, but resolves (and kills the child) as soon as
// `marker` appears in stdout, instead of waiting for full completion. Used
// for a flow that continues past the confirmation into real, potentially
// slow work (e.g. driving a real installed backend CLI) that this test has
// no need to wait out — only that the confirmation itself did not block.
function runUntilMarkerOrTimeout(args, marker, boundMs = BOUND_MS, cwd = FIXTURE_DIR) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      resolvePromise(result);
    };
    child.stdout.on('data', (d) => {
      stdout += d;
      if (stdout.includes(marker)) finish({ timedOut: false, sawMarker: true, stdout });
    });
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => finish({ timedOut: true, sawMarker: false, stdout }), boundMs);
    child.on('exit', () => finish({ timedOut: false, sawMarker: stdout.includes(marker), stdout }));
  });
}

describe('aspens add — non-interactive stdin never hangs', () => {
  it('fails fast instead of hanging on the resource picker when no name is given', async () => {
    const { timedOut, code, stderr } = await runWithOpenStdin(['add', 'agent']);

    expect(timedOut).toBe(false);
    expect(code).not.toBe(0);
    expect(stderr).toContain('non-interactive session');
  }, BOUND_MS + 3000);
});

describe('aspens save-tokens — non-interactive stdin never hangs', () => {
  it('fails fast instead of hanging on the feature picker when no flag resolves the choice', async () => {
    const { timedOut, code, stderr } = await runWithOpenStdin(['save-tokens']);

    expect(timedOut).toBe(false);
    expect(code).not.toBe(0);
    expect(stderr).toContain('non-interactive session');
    expect(stderr).toContain('--recommended');
  }, BOUND_MS + 3000);
});

describe('aspens doc impact --apply — non-interactive stdin never hangs', () => {
  it('fails fast instead of hanging on the apply confirmation when no flag resolves it', async () => {
    // A fixture with no generated docs at all always yields a non-empty
    // apply plan ("aspens doc init --recommended"), reaching the confirm —
    // no backend CLI is required to get there (interpretation is optional
    // and skipped when none is installed).
    const { timedOut, code, stderr } = await runWithOpenStdin(['doc', 'impact', '--apply', '--no-graph']);

    expect(timedOut).toBe(false);
    expect(code).not.toBe(0);
    expect(stderr).toContain('non-interactive session');
  }, BOUND_MS + 3000);

  it('resolves the apply confirmation via --yes instead of hanging', async () => {
    // Applying proceeds into real work (running the recommended `doc init`),
    // which this test has no need to wait out — only that "Applying" is
    // reached without the confirmation ever blocking on open stdin.
    const { timedOut, sawMarker } = await runUntilMarkerOrTimeout(
      ['doc', 'impact', '--apply', '--yes', '--no-graph'],
      'Applying'
    );

    expect(timedOut).toBe(false);
    expect(sawMarker).toBe(true);
  }, BOUND_MS + 3000);
});

describe('aspens customize agents — non-interactive stdin never hangs', () => {
  it('fails fast instead of hanging on the update confirmation when no flag resolves it', async () => {
    writeFileSync(join(FIXTURE_DIR, 'CLAUDE.md'), '# fixture\n', 'utf8');
    mkdirSync(join(FIXTURE_DIR, '.claude', 'skills', 'base'), { recursive: true });
    writeFileSync(join(FIXTURE_DIR, '.claude', 'skills', 'base', 'skill.md'), '# base skill\n', 'utf8');
    mkdirSync(join(FIXTURE_DIR, '.claude', 'agents'), { recursive: true });
    writeFileSync(
      join(FIXTURE_DIR, '.claude', 'agents', 'reviewer.md'),
      '---\nname: reviewer\n---\n\nYou are a reviewer agent.\n',
      'utf8'
    );

    // Stubs the backend call so the test exercises the update-confirmation
    // guard directly, without depending on a real installed/authenticated
    // backend CLI or waiting out an actual generation call.
    vi.resetModules();
    vi.doMock('../src/lib/runner.js', () => ({
      runClaude: vi.fn().mockResolvedValue({ text: '<file path="AGENTS.md">customized</file>' }),
      loadPrompt: vi.fn().mockReturnValue('mock prompt'),
      parseFileOutput: vi.fn().mockReturnValue([{ path: 'AGENTS.md', content: 'customized' }]),
    }));
    const originalIsTTY = process.stdin.isTTY;
    const originalCwd = process.cwd();
    process.stdin.isTTY = false;
    process.chdir(FIXTURE_DIR);
    try {
      const { customizeCommand } = await import('../src/commands/customize.js');
      await expect(customizeCommand('agents', { timeout: 5 })).rejects.toThrow(/non-interactive session/);
    } finally {
      process.chdir(originalCwd);
      process.stdin.isTTY = originalIsTTY;
      vi.doUnmock('../src/lib/runner.js');
      vi.resetModules();
    }
  }, BOUND_MS);
});
