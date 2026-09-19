/**
 * End-to-end regression: `aspens doc sync` must never destructively rewrite a
 * hand-authored AGENTS.md when the configured targets include opencode.
 *
 * Live repro (worktrail, aspens 0.9.0 @ e1af89f, targets [claude, opencode]):
 * CLAUDE.md = `@AGENTS.md` gained inline `## Skills`/`## Behavior`, and the
 * transformed CLAUDE.md was then published wholesale as AGENTS.md — the
 * 147-line hand-authored file shrank to 18 lines beginning with a
 * self-referencing `@AGENTS.md`. Only repairDeterministicSections used the
 * aspens import block; the --refresh path and the LLM commit-sync path
 * bypassed it.
 *
 * With the claude target's instructions file resolved per repo, an `@AGENTS.md`
 * shim CLAUDE.md means claude records `AGENTS.md` — the same root file
 * opencode (or codex) publishes to. The shim is never touched; the shared
 * AGENTS.md is the claude target's instructions file and keeps the import
 * layout (one delimited block importing `.claude/aspens-index.md`), so the
 * two-hop chain CLAUDE.md -> AGENTS.md -> aspens-index.md is intact and the
 * dest target never publishes a competing transformed version of that path.
 *
 * Both real paths run twice here for each dest target: content outside the
 * delimited aspens block must be byte-for-byte unchanged in AGENTS.md,
 * CLAUDE.md must be byte-for-byte unchanged, and the second run must be a no-op.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';

vi.mock('../src/lib/runner.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, runLLM: vi.fn(async () => ({ text: '' })) };
});

const { docSyncCommand } = await import('../src/commands/doc-sync.js');

const REPO = join(import.meta.dirname, 'tmp-doc-sync-managed-block');
const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const AGENTS_MD = [
  '# Hand-authored AGENTS.md',
  '',
  '## Conventions',
  '',
  '- ESM only.',
  '- Never `require()`.',
  '',
  '## Behavior',
  '',
  '- The user wrote this section; aspens must leave it alone.',
  '',
].join('\n');
const CLAUDE_MD = '@AGENTS.md\n';

const BLOCK_RE = /\n*<!-- aspens:start -->[\s\S]*?<!-- aspens:end -->\n?/g;
const outsideBlock = (content) => content.replace(BLOCK_RE, '\n');
const blocks = (content) => content.match(BLOCK_RE) || [];

function setupRepo(destTarget) {
  if (existsSync(REPO)) rmSync(REPO, { recursive: true, force: true });
  mkdirSync(join(REPO, '.claude', 'skills', 'base'), { recursive: true });
  mkdirSync(join(REPO, '.claude', 'skills', 'billing'), { recursive: true });
  writeFileSync(join(REPO, '.claude', 'skills', 'base', 'skill.md'), '---\nname: base\ndescription: Core conventions\n---\n\nBase.\n');
  writeFileSync(join(REPO, '.claude', 'skills', 'billing', 'skill.md'), '---\nname: billing\ndescription: Stripe billing flows\n---\n\nBilling.\n');
  writeFileSync(join(REPO, '.aspens.json'), JSON.stringify({ targets: ['claude', destTarget], backend: 'claude' }) + '\n');
  writeFileSync(join(REPO, 'AGENTS.md'), AGENTS_MD);
  writeFileSync(join(REPO, 'CLAUDE.md'), CLAUDE_MD);
  writeFileSync(join(REPO, 'index.js'), 'export const a = 1;\n');
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  // A code-bearing change so the commit-sync path reaches the LLM step.
  writeFileSync(join(REPO, 'index.js'), 'export const a = 2;\n');
  git('commit', '-q', '-am', 'change');
}

afterAll(() => {
  if (existsSync(REPO)) rmSync(REPO, { recursive: true, force: true });
});

function assertPreserved() {
  const agents = readFileSync(join(REPO, 'AGENTS.md'), 'utf8');
  const claude = readFileSync(join(REPO, 'CLAUDE.md'), 'utf8');

  expect(outsideBlock(agents).trimEnd()).toBe(AGENTS_MD.trimEnd());
  expect(blocks(agents)).toHaveLength(1);
  expect(agents).not.toMatch(/^@AGENTS\.md/m);
  expect(agents).not.toContain('.opencode/skills');
  expect(agents).not.toContain('.agents/skills');
  // AGENTS.md is the claude target's recorded instructions file: it keeps the
  // import layout, never an inlined Skills/Behavior block, regardless of the
  // dest target that shares the path.
  expect(blocks(agents)[0]).toContain('@.claude/aspens-index.md');
  expect(blocks(agents)[0]).not.toMatch(/## Skills/);

  // The `@AGENTS.md` shim is the recorded pointer, never a publish target.
  expect(claude).toBe(CLAUDE_MD);
  expect(blocks(claude)).toHaveLength(0);

  // The index is imported from AGENTS.md, so it is written and current.
  const index = readFileSync(join(REPO, '.claude', 'aspens-index.md'), 'utf8');
  expect(index).toContain('.claude/skills/billing/skill.md');
}

async function runTwiceAndAssertIdempotent(options) {
  const tracked = ['AGENTS.md', 'CLAUDE.md', '.claude/aspens-index.md'];
  await docSyncCommand(REPO, options);
  assertPreserved();
  const snapshot = tracked.map(f => readFileSync(join(REPO, f), 'utf8'));

  await docSyncCommand(REPO, options);
  assertPreserved();
  const again = tracked.map(f => readFileSync(join(REPO, f), 'utf8'));
  expect(again).toEqual(snapshot);
}

describe('doc sync with targets [claude, opencode] and a hand-authored AGENTS.md', () => {
  beforeEach(() => setupRepo('opencode'));

  it('commit-sync path keeps AGENTS.md and CLAUDE.md intact outside the aspens block', async () => {
    await runTwiceAndAssertIdempotent({ graph: false, commits: 1 });
  });

  it('--refresh path keeps AGENTS.md and CLAUDE.md intact outside the aspens block', async () => {
    await runTwiceAndAssertIdempotent({ graph: false, refresh: true });
  });
});

describe('doc sync with targets [claude, codex] and a hand-authored AGENTS.md', () => {
  beforeEach(() => setupRepo('codex'));

  it('commit-sync path keeps the claude import layout in the shared AGENTS.md', async () => {
    await runTwiceAndAssertIdempotent({ graph: false, commits: 1 });
  });

  it('--refresh path keeps the claude import layout in the shared AGENTS.md', async () => {
    await runTwiceAndAssertIdempotent({ graph: false, refresh: true });
  });
});

describe('doc sync with the claude target recording AGENTS.md as its instructions file', () => {
  function setupClaudeOnly({ claudeMd, agentsMd }) {
    setupRepo('codex');
    writeFileSync(join(REPO, '.aspens.json'), JSON.stringify({ targets: ['claude'], backend: 'claude', instructionsFile: 'AGENTS.md' }) + '\n');
    rmSync(join(REPO, 'CLAUDE.md'), { force: true });
    if (claudeMd !== null) writeFileSync(join(REPO, 'CLAUDE.md'), claudeMd);
    if (agentsMd === null) rmSync(join(REPO, 'AGENTS.md'), { force: true });
  }

  it('commit-sync repair fixes AGENTS.md and leaves a shim CLAUDE.md byte-identical', async () => {
    setupClaudeOnly({ claudeMd: CLAUDE_MD, agentsMd: AGENTS_MD });
    await docSyncCommand(REPO, { graph: false, commits: 1 });

    const agents = readFileSync(join(REPO, 'AGENTS.md'), 'utf8');
    expect(outsideBlock(agents).trimEnd()).toBe(AGENTS_MD.trimEnd());
    expect(blocks(agents)).toHaveLength(1);
    expect(blocks(agents)[0]).toContain('@.claude/aspens-index.md');
    expect(readFileSync(join(REPO, 'CLAUDE.md'), 'utf8')).toBe(CLAUDE_MD);
  });

  it('--refresh refreshes AGENTS.md without creating CLAUDE.md', async () => {
    setupClaudeOnly({ claudeMd: null, agentsMd: AGENTS_MD });
    await docSyncCommand(REPO, { graph: false, refresh: true });

    const agents = readFileSync(join(REPO, 'AGENTS.md'), 'utf8');
    expect(outsideBlock(agents).trimEnd()).toBe(AGENTS_MD.trimEnd());
    expect(blocks(agents)).toHaveLength(1);
    expect(existsSync(join(REPO, 'CLAUDE.md'))).toBe(false);
  });

  it('a recorded AGENTS.md that was deleted makes no root change and creates no CLAUDE.md', async () => {
    setupClaudeOnly({ claudeMd: null, agentsMd: null });
    await docSyncCommand(REPO, { graph: false, refresh: true });

    expect(existsSync(join(REPO, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(REPO, 'CLAUDE.md'))).toBe(false);
  });
});
