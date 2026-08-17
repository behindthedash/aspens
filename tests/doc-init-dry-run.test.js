import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'fs';
import { spawn } from 'child_process';
import { join, delimiter } from 'path';

const CLI = join(import.meta.dirname, '..', 'bin', 'cli.js');
const FAKE_BIN_DIR = join(import.meta.dirname, 'fixtures', 'fake-bin');
const FIXTURE_DIR = join(import.meta.dirname, 'tmp-dry-run-fixture');
const BOUND_MS = 15000;

beforeEach(() => {
  if (existsSync(FIXTURE_DIR)) rmSync(FIXTURE_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(join(FIXTURE_DIR, 'package.json'), JSON.stringify({ name: 'fixture' }), 'utf8');
  writeFileSync(join(FIXTURE_DIR, 'index.js'), 'console.log("hi");\n', 'utf8');
  // An existing CLAUDE.md makes --yes skip the discovery-agents phase
  // (doc-init.js:459-460) so the fake `claude` binary's hang is hit on the
  // first real generateChunked call (base skill) instead of discovery.
  writeFileSync(join(FIXTURE_DIR, 'CLAUDE.md'), '# fixture\n', 'utf8');
});

afterAll(() => {
  if (existsSync(FIXTURE_DIR)) rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

// Regression for the reported "--dry-run silently writes real files in
// chunked mode" bug: kills `doc init --dry-run --mode chunked` mid-generation
// (using a fake `claude` binary that hangs forever with no network/auth) and
// asserts the fixture directory is byte-for-byte untouched — chunked mode's
// incremental writer must never fire while --dry-run is set, no matter when
// the process is interrupted.
describe('doc init --dry-run — never writes files, even killed mid-generation', () => {
  it('leaves the target repo untouched when killed mid-generation', async () => {
    const child = spawn(process.execPath, [
      CLI, 'doc', 'init', '--backend', 'claude', '--target', 'claude',
      '--mode', 'chunked', '--dry-run', '--yes', '--no-hook',
    ], {
      cwd: FIXTURE_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${FAKE_BIN_DIR}${delimiter}${process.env.PATH}` },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    const killedMidGeneration = await new Promise((resolvePromise) => {
      const poll = setInterval(() => {
        if (stdout.includes('Generating')) {
          clearInterval(poll);
          clearTimeout(bound);
          child.kill('SIGKILL');
          resolvePromise(true);
        }
      }, 50);
      const bound = setTimeout(() => {
        clearInterval(poll);
        child.kill('SIGKILL');
        resolvePromise(false);
      }, BOUND_MS);
    });

    // Give the killed process a moment to fully exit before inspecting disk.
    await new Promise((r) => setTimeout(r, 200));

    expect(killedMidGeneration, `never reached generation — stdout: ${stdout} stderr: ${stderr}`).toBe(true);

    const entries = readdirSync(FIXTURE_DIR).sort();
    expect(entries).toEqual(['CLAUDE.md', 'index.js', 'package.json']);
    expect(readFileSync(join(FIXTURE_DIR, 'CLAUDE.md'), 'utf8')).toBe('# fixture\n');
    expect(existsSync(join(FIXTURE_DIR, '.claude'))).toBe(false);
  }, BOUND_MS + 3000);
});
