import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join, delimiter } from 'path';
import { readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { runClaude } from '../src/lib/runner.js';

// Regression: `--allowedTools` only pre-approves tools for Claude Code's
// interactive permission prompt. In non-interactive `-p` mode (which
// runClaude always uses) there's no prompt to skip, so `--allowedTools` has
// no restrictive effect — the CLI's full default tool set (Write, Edit,
// Bash, ...) stays available regardless. Confirmed live: `claude -p
// --allowedTools Read,Glob,Grep` still wrote a file when asked; `claude -p
// --tools Read,Glob,Grep` correctly refused. This let doc-init's
// "read-only" generation calls (makeClaudeOptions) write canonical files
// (CLAUDE.md, .claude/skills/*) directly via their own Write tool, bypassing
// aspens' own target-based filtering — e.g. a CLAUDE.md landing on disk on a
// `--target codex` run. runClaude must pass `--tools`, not `--allowedTools`.
const FAKE_BIN_DIR = join(import.meta.dirname, 'fixtures', 'fake-bin-argv-capture');

let originalPath;
let captureFile;

beforeEach(() => {
  originalPath = process.env.PATH;
  process.env.PATH = `${FAKE_BIN_DIR}${delimiter}${originalPath}`;
  captureFile = join(tmpdir(), `aspens-test-argv-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  process.env.ASPENS_TEST_ARGV_CAPTURE_FILE = captureFile;
});

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.ASPENS_TEST_ARGV_CAPTURE_FILE;
  if (existsSync(captureFile)) rmSync(captureFile);
});

describe('runClaude — tool-restriction flag', () => {
  it('passes --tools (a real allowlist), not --allowedTools (advisory-only in -p mode)', async () => {
    await runClaude('irrelevant prompt', { timeout: 10000, allowedTools: ['Read', 'Glob', 'Grep'] });

    const args = JSON.parse(readFileSync(captureFile, 'utf8'));
    expect(args).toContain('--tools');
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep');
    expect(args).not.toContain('--allowedTools');
  });
});
