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
 * Both real paths run twice here: content outside the delimited aspens block
 * must be byte-for-byte unchanged in AGENTS.md and CLAUDE.md, and the second
 * run must be a no-op.
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

beforeEach(() => {
  if (existsSync(REPO)) rmSync(REPO, { recursive: true, force: true });
  mkdirSync(join(REPO, '.claude', 'skills', 'base'), { recursive: true });
  mkdirSync(join(REPO, '.claude', 'skills', 'billing'), { recursive: true });
  writeFileSync(join(REPO, '.claude', 'skills', 'base', 'skill.md'), '---\nname: base\ndescription: Core conventions\n---\n\nBase.\n');
  writeFileSync(join(REPO, '.claude', 'skills', 'billing', 'skill.md'), '---\nname: billing\ndescription: Stripe billing flows\n---\n\nBilling.\n');
  writeFileSync(join(REPO, '.aspens.json'), JSON.stringify({ targets: ['claude', 'opencode'], backend: 'claude' }) + '\n');
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
});

afterAll(() => {
  if (existsSync(REPO)) rmSync(REPO, { recursive: true, force: true });
});

function assertPreserved() {
  const agents = readFileSync(join(REPO, 'AGENTS.md'), 'utf8');
  const claude = readFileSync(join(REPO, 'CLAUDE.md'), 'utf8');

  expect(outsideBlock(agents).trimEnd()).toBe(AGENTS_MD.trimEnd());
  expect(blocks(agents)).toHaveLength(1);
  expect(agents).not.toMatch(/^@AGENTS\.md/m);
  expect(agents).toContain('.claude/skills/billing/skill.md');
  expect(agents).not.toContain('.opencode/skills');

  expect(outsideBlock(claude).trimEnd()).toBe(CLAUDE_MD.trimEnd());
  expect(blocks(claude)).toHaveLength(1);
  expect(claude).toContain('@.claude/aspens-index.md');
  expect(claude).not.toMatch(/^## Skills/m);

  const index = readFileSync(join(REPO, '.claude', 'aspens-index.md'), 'utf8');
  expect(index).toContain('.claude/skills/billing/skill.md');
}

async function runTwiceAndAssertIdempotent(options) {
  await docSyncCommand(REPO, options);
  assertPreserved();
  const snapshot = ['AGENTS.md', 'CLAUDE.md', '.claude/aspens-index.md']
    .map(f => readFileSync(join(REPO, f), 'utf8'));

  await docSyncCommand(REPO, options);
  assertPreserved();
  const again = ['AGENTS.md', 'CLAUDE.md', '.claude/aspens-index.md']
    .map(f => readFileSync(join(REPO, f), 'utf8'));
  expect(again).toEqual(snapshot);
}

describe('doc sync with targets [claude, opencode] and a hand-authored AGENTS.md', () => {
  it('commit-sync path keeps AGENTS.md and CLAUDE.md intact outside the aspens block', async () => {
    await runTwiceAndAssertIdempotent({ graph: false, commits: 1 });
  });

  it('--refresh path keeps AGENTS.md and CLAUDE.md intact outside the aspens block', async () => {
    await runTwiceAndAssertIdempotent({ graph: false, refresh: true });
  });
});
