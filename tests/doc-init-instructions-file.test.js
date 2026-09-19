/**
 * `aspens doc init` with a resolved claude root instructions file.
 *
 * The claude target's instructions file is resolved per repo (override >
 * .aspens.json > on-disk detection > CLAUDE.md). These tests drive the real
 * docInitCommand with a mocked runner (following the mocked-runner pattern in
 * tests/doc-init-reuse-source.test.js / tests/doc-sync-managed-block.test.js)
 * and assert on what lands on disk, which prompts the LLM saw, and what
 * .aspens.json records.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

vi.mock('../src/lib/runner.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, runLLM: vi.fn(async () => ({ text: '' })) };
});

vi.mock('../src/lib/backend.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    detectAvailableBackends: vi.fn(() => ({ claude: true, codex: false, opencode: false })),
  };
});

const { runLLM } = await import('../src/lib/runner.js');
const { detectAvailableBackends } = await import('../src/lib/backend.js');
const { docInitCommand } = await import('../src/commands/doc-init.js');
const { CliError } = await import('../src/lib/errors.js');

const REPO = join(import.meta.dirname, 'tmp-doc-init-instructions-file');

const BASE_SKILL = [
  '<file path=".claude/skills/base/skill.md">',
  '---',
  'name: base',
  'description: Core conventions',
  '---',
  '',
  '# Base',
  '',
  'ESM only.',
  '</file>',
].join('\n');

const ROOT_DOC = [
  '# demo-repo',
  '',
  '## Architecture',
  '',
  'Single ESM entry point in index.js.',
  '',
  '## Conventions',
  '',
  '- ESM only.',
  '- Never `require()`.',
].join('\n');

const wrap = (path, body) => `<file path="${path}">\n${body}\n</file>`;

const SHIM_CLAUDE_MD = '<!-- keep this shim -->\n@AGENTS.md\n';
const HAND_AGENTS_MD = [
  '# Hand-authored AGENTS.md',
  '',
  '## Conventions',
  '',
  '- ESM only.',
  '- Never `require()`.',
  '',
].join('\n');

const BLOCK_RE = /<!-- aspens:start -->[\s\S]*?<!-- aspens:end -->/;

const isBasePrompt = (prompt) => prompt.includes('Generate ONLY the base skill');

/**
 * Install a runLLM implementation that answers the base-skill prompt with a
 * base skill and every other prompt with `rootAnswers` in order (the last one
 * repeats). Returns the list of non-base prompts seen.
 */
function mockRuns(rootAnswers) {
  const rootPrompts = [];
  let i = 0;
  runLLM.mockImplementation(async (prompt) => {
    if (isBasePrompt(prompt)) return { text: BASE_SKILL };
    rootPrompts.push(prompt);
    const answer = rootAnswers[Math.min(i, rootAnswers.length - 1)];
    i++;
    return { text: answer };
  });
  return rootPrompts;
}

const baseOptions = () => ({
  yes: true,
  backend: 'claude',
  target: 'claude',
  mode: 'base-only',
  graph: false,
  hooks: false,
  hook: false,
});

const readConfig = () => JSON.parse(readFileSync(join(REPO, '.aspens.json'), 'utf8'));
const read = (rel) => readFileSync(join(REPO, rel), 'utf8');
const exists = (rel) => existsSync(join(REPO, rel));

beforeEach(() => {
  vi.clearAllMocks();
  if (existsSync(REPO)) rmSync(REPO, { recursive: true, force: true });
  mkdirSync(REPO, { recursive: true });
  writeFileSync(join(REPO, 'package.json'), JSON.stringify({ name: 'demo-repo', type: 'module' }) + '\n');
  writeFileSync(join(REPO, 'index.js'), 'export const a = 1;\n');
});

afterAll(() => {
  if (existsSync(REPO)) rmSync(REPO, { recursive: true, force: true });
});

describe('doc init --instructions-file AGENTS.md on a fresh repo', () => {
  it('forces AGENTS.md and never creates CLAUDE.md', async () => {
    const rootPrompts = mockRuns([wrap('AGENTS.md', ROOT_DOC)]);

    await docInitCommand(REPO, { ...baseOptions(), instructionsFile: 'AGENTS.md' });

    expect(exists('AGENTS.md')).toBe(true);
    expect(exists('CLAUDE.md')).toBe(false);
    const agents = read('AGENTS.md');
    expect(agents).toContain('# demo-repo');
    expect(agents).toMatch(BLOCK_RE);
    expect(agents).toContain('@.claude/aspens-index.md');
    expect(exists('.claude/aspens-index.md')).toBe(true);

    // The root-instructions prompt asks for AGENTS.md, not CLAUDE.md.
    expect(rootPrompts).toHaveLength(1);
    expect(rootPrompts[0]).toContain('<file path="AGENTS.md">');
    expect(rootPrompts[0]).not.toContain('CLAUDE.md');

    expect(readConfig().instructionsFile).toBe('AGENTS.md');
  });
});

describe('doc init on a repo whose CLAUDE.md is an @AGENTS.md shim', () => {
  beforeEach(() => {
    writeFileSync(join(REPO, 'CLAUDE.md'), SHIM_CLAUDE_MD);
    writeFileSync(join(REPO, 'AGENTS.md'), HAND_AGENTS_MD);
  });

  it('leaves the shim byte-identical and puts the aspens block in AGENTS.md', async () => {
    const rootPrompts = mockRuns([wrap('AGENTS.md', ROOT_DOC)]);

    await docInitCommand(REPO, { ...baseOptions(), strategy: 'rewrite' });

    expect(read('CLAUDE.md')).toBe(SHIM_CLAUDE_MD);
    const agents = read('AGENTS.md');
    expect(agents).toMatch(BLOCK_RE);
    expect(agents).toContain('@.claude/aspens-index.md');
    expect(agents).toContain('# demo-repo');

    expect(rootPrompts).toHaveLength(1);
    expect(rootPrompts[0]).toContain('<file path="AGENTS.md">');
    expect(readConfig().instructionsFile).toBe('AGENTS.md');
  });

  it('keeps a hand-authored ## Behavior section in AGENTS.md outside the aspens block', async () => {
    const withBehavior = ROOT_DOC + '\n\n## Behavior\n\n- Hand-authored; must survive.';
    mockRuns([wrap('AGENTS.md', withBehavior)]);

    await docInitCommand(REPO, { ...baseOptions(), strategy: 'rewrite' });

    const agents = read('AGENTS.md');
    expect(agents).toContain('## Behavior');
    expect(agents).toContain('- Hand-authored; must survive.');
    expect(agents).toMatch(BLOCK_RE);
    expect(read('CLAUDE.md')).toBe(SHIM_CLAUDE_MD);
  });

  it('rejects <file path="CLAUDE.md"> output and retries until AGENTS.md is produced', async () => {
    const rootPrompts = mockRuns([
      wrap('CLAUDE.md', ROOT_DOC),
      wrap('AGENTS.md', ROOT_DOC + '\n\n## From retry\n\nSecond attempt.'),
    ]);

    await docInitCommand(REPO, { ...baseOptions(), strategy: 'rewrite' });

    // base + first root attempt + one retry
    expect(runLLM).toHaveBeenCalledTimes(3);
    expect(rootPrompts).toHaveLength(2);
    expect(rootPrompts[1]).toContain('<file path="AGENTS.md">');

    expect(read('CLAUDE.md')).toBe(SHIM_CLAUDE_MD);
    const agents = read('AGENTS.md');
    expect(agents).toContain('## From retry');
    expect(agents).not.toContain('<file path=');
    expect(agents).toMatch(BLOCK_RE);
  });
});

describe('doc init strategies against an existing AGENTS.md (no CLAUDE.md)', () => {
  beforeEach(() => {
    writeFileSync(join(REPO, 'AGENTS.md'), HAND_AGENTS_MD);
  });

  it('improve strategy feeds the existing AGENTS.md into the prompt', async () => {
    const rootPrompts = mockRuns([wrap('AGENTS.md', ROOT_DOC)]);

    await docInitCommand(REPO, { ...baseOptions(), strategy: 'improve' });

    expect(rootPrompts).toHaveLength(1);
    expect(rootPrompts[0]).toMatch(/#{2,3} Existing AGENTS\.md/);
    expect(rootPrompts[0]).toContain('# Hand-authored AGENTS.md');
    expect(rootPrompts[0]).not.toMatch(/Existing CLAUDE\.md/);

    expect(exists('CLAUDE.md')).toBe(false);
    expect(read('AGENTS.md')).toMatch(BLOCK_RE);
    expect(readConfig().instructionsFile).toBe('AGENTS.md');
  });

  it('skip strategy keeps the existing AGENTS.md and makes no root-instructions call', async () => {
    const rootPrompts = mockRuns([wrap('AGENTS.md', ROOT_DOC)]);

    await docInitCommand(REPO, { ...baseOptions(), strategy: 'skip' });

    // Only the base skill was generated.
    expect(runLLM).toHaveBeenCalledTimes(1);
    expect(rootPrompts).toHaveLength(0);
    expect(read('AGENTS.md')).toBe(HAND_AGENTS_MD);
    expect(exists('CLAUDE.md')).toBe(false);
    expect(exists('.claude/skills/base/skill.md')).toBe(true);
    expect(readConfig().instructionsFile).toBe('AGENTS.md');
  });
});

describe('doc init --instructions-file validation', () => {
  it('rejects an invalid value before any backend or runner call', async () => {
    mockRuns([wrap('CLAUDE.md', ROOT_DOC)]);

    await expect(docInitCommand(REPO, { ...baseOptions(), instructionsFile: 'codex.md' }))
      .rejects.toThrow(CliError);
    await expect(docInitCommand(REPO, { ...baseOptions(), instructionsFile: 'codex.md' }))
      .rejects.toThrow(/Invalid --instructions-file value/);

    expect(runLLM).not.toHaveBeenCalled();
    expect(detectAvailableBackends).not.toHaveBeenCalled();
    expect(exists('.aspens.json')).toBe(false);
  });

  it('rejects --target codex before any backend or runner call', async () => {
    mockRuns([wrap('AGENTS.md', ROOT_DOC)]);

    await expect(docInitCommand(REPO, { ...baseOptions(), target: 'codex', instructionsFile: 'AGENTS.md' }))
      .rejects.toThrow(CliError);
    await expect(docInitCommand(REPO, { ...baseOptions(), target: 'codex', instructionsFile: 'AGENTS.md' }))
      .rejects.toThrow(/only applies to the claude target/);

    expect(runLLM).not.toHaveBeenCalled();
    expect(detectAvailableBackends).not.toHaveBeenCalled();
    expect(exists('.aspens.json')).toBe(false);
  });
});

describe('doc init when CLAUDE.md is the resolved instructions file', () => {
  it('records instructionsFile: CLAUDE.md and produces the same output with or without the explicit override', async () => {
    // Run 1: no override on a fresh repo — resolver falls back to CLAUDE.md.
    const promptsDefault = mockRuns([wrap('CLAUDE.md', ROOT_DOC)]);
    await docInitCommand(REPO, baseOptions());

    expect(exists('CLAUDE.md')).toBe(true);
    expect(exists('AGENTS.md')).toBe(false);
    expect(readConfig().instructionsFile).toBe('CLAUDE.md');
    expect(promptsDefault).toHaveLength(1);
    expect(promptsDefault[0]).toContain('<file path="CLAUDE.md">');
    expect(promptsDefault[0]).not.toContain('AGENTS.md');

    const claudeDefault = read('CLAUDE.md');
    const indexDefault = read('.claude/aspens-index.md');
    const baseDefault = read('.claude/skills/base/skill.md');
    expect(claudeDefault).toMatch(BLOCK_RE);
    expect(claudeDefault).toContain('@.claude/aspens-index.md');

    // Run 2: same fresh repo, explicit --instructions-file CLAUDE.md.
    rmSync(REPO, { recursive: true, force: true });
    mkdirSync(REPO, { recursive: true });
    writeFileSync(join(REPO, 'package.json'), JSON.stringify({ name: 'demo-repo', type: 'module' }) + '\n');
    writeFileSync(join(REPO, 'index.js'), 'export const a = 1;\n');
    vi.clearAllMocks();
    const promptsExplicit = mockRuns([wrap('CLAUDE.md', ROOT_DOC)]);
    await docInitCommand(REPO, { ...baseOptions(), instructionsFile: 'CLAUDE.md' });

    expect(exists('AGENTS.md')).toBe(false);
    expect(readConfig().instructionsFile).toBe('CLAUDE.md');
    expect(promptsExplicit).toEqual(promptsDefault);
    expect(read('CLAUDE.md')).toBe(claudeDefault);
    expect(read('.claude/aspens-index.md')).toBe(indexDefault);
    expect(read('.claude/skills/base/skill.md')).toBe(baseDefault);
  });
});
