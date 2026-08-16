import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { TARGETS } from '../src/lib/target.js';
import {
  isTrivialImportStub,
  targetHasSubstantiveInstructions,
  chooseReuseSourceTarget,
  disambiguateOpenCodeReuseSource,
  assertNoTargetPathConflicts,
  looksLikeConversationalNonAnswer,
  looksLikeDrasticContentLoss,
  buildOutputFilesForTargets,
} from '../src/commands/doc-init.js';
import { scanRepo } from '../src/lib/scanner.js';

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures', 'reuse-source');

beforeEach(() => {
  if (existsSync(FIXTURES_DIR)) rmSync(FIXTURES_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURES_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(FIXTURES_DIR, { recursive: true, force: true });
});

describe('isTrivialImportStub', () => {
  it('treats a bare @<path> import as trivial', () => {
    expect(isTrivialImportStub('@AGENTS.md')).toBe(true);
    expect(isTrivialImportStub('@AGENTS.md\n')).toBe(true);
    expect(isTrivialImportStub('  @AGENTS.md  \n')).toBe(true);
  });

  it('treats empty/whitespace-only content as trivial', () => {
    expect(isTrivialImportStub('')).toBe(true);
    expect(isTrivialImportStub('   \n  ')).toBe(true);
    expect(isTrivialImportStub(null)).toBe(true);
    expect(isTrivialImportStub(undefined)).toBe(true);
  });

  it('does not treat real content as trivial', () => {
    expect(isTrivialImportStub('# Repo\n\nReal architecture docs go here.')).toBe(false);
    expect(isTrivialImportStub('@AGENTS.md\n\nplus more content below')).toBe(false);
  });
});

describe('chooseReuseSourceTarget — content-loss regression (aspens #issue: improve strategy discards real docs)', () => {
  it('prefers the target with real content when the other is a bare @import stub', () => {
    // Mirrors the datalena case: CLAUDE.md is a one-line `@AGENTS.md` import,
    // AGENTS.md holds the real, substantial content.
    writeFileSync(join(FIXTURES_DIR, 'CLAUDE.md'), '@AGENTS.md\n', 'utf8');
    writeFileSync(join(FIXTURES_DIR, 'AGENTS.md'), '# Real Handbook\n\n'.repeat(50), 'utf8');

    // Regression case from the live incident: user wants only the codex
    // target. Before the fix this returned TARGETS.claude (reading the
    // stub), collapsing 400+ lines of real AGENTS.md content down to a
    // handful of generated lines.
    const chosen = chooseReuseSourceTarget([TARGETS.codex], true, true, FIXTURES_DIR);
    expect(chosen).toBe(TARGETS.codex);
  });

  it('prefers claude when codex is the stub and claude has the real content', () => {
    writeFileSync(join(FIXTURES_DIR, 'AGENTS.md'), '@CLAUDE.md\n', 'utf8');
    writeFileSync(join(FIXTURES_DIR, 'CLAUDE.md'), '# Real Handbook\n\n'.repeat(50), 'utf8');

    const chosen = chooseReuseSourceTarget([TARGETS.claude], true, true, FIXTURES_DIR);
    expect(chosen).toBe(TARGETS.claude);
  });

  it('falls back to prior heuristics when both files have real content', () => {
    writeFileSync(join(FIXTURES_DIR, 'CLAUDE.md'), '# Claude docs\n\nreal content'.repeat(10), 'utf8');
    writeFileSync(join(FIXTURES_DIR, 'AGENTS.md'), '# Codex docs\n\nreal content'.repeat(10), 'utf8');

    // Existing behavior preserved: wants codex only, both substantive ->
    // still prefers claude per the original "reuse the other format" heuristic.
    const chosen = chooseReuseSourceTarget([TARGETS.codex], true, true, FIXTURES_DIR);
    expect(chosen).toBe(TARGETS.claude);
  });

  it('is a no-op without repoPath (backward compatible)', () => {
    const chosen = chooseReuseSourceTarget([TARGETS.codex], true, true);
    expect(chosen).toBe(TARGETS.claude);
  });
});

describe('disambiguateOpenCodeReuseSource', () => {
  it('remaps codex to opencode when only opencode-shaped artifacts are present', () => {
    // OpenCode repo: AGENTS.md + .claude/skills, no .codex/ or .agents/skills.
    // chooseReuseSourceTarget can't tell this apart from codex on its own
    // (both share AGENTS.md as instructionsFile), so it returns TARGETS.codex.
    const scan = { hasCodexConfig: false, hasAgentsSkills: false };
    expect(disambiguateOpenCodeReuseSource(TARGETS.codex, scan)).toBe(TARGETS.opencode);
  });

  it('leaves codex as codex when codex-specific artifacts are present', () => {
    const withCodexConfig = { hasCodexConfig: true, hasAgentsSkills: false };
    expect(disambiguateOpenCodeReuseSource(TARGETS.codex, withCodexConfig)).toBe(TARGETS.codex);

    const withAgentsSkills = { hasCodexConfig: false, hasAgentsSkills: true };
    expect(disambiguateOpenCodeReuseSource(TARGETS.codex, withAgentsSkills)).toBe(TARGETS.codex);
  });

  it('leaves claude and null untouched', () => {
    const scan = { hasCodexConfig: false, hasAgentsSkills: false };
    expect(disambiguateOpenCodeReuseSource(TARGETS.claude, scan)).toBe(TARGETS.claude);
    expect(disambiguateOpenCodeReuseSource(null, scan)).toBe(null);
  });
});

describe('assertNoTargetPathConflicts', () => {
  it('throws when claude and opencode are combined (both write .claude/skills)', () => {
    expect(() => assertNoTargetPathConflicts([TARGETS.claude, TARGETS.opencode])).toThrow(
      /both write \.claude\/skills/
    );
  });

  it('throws when codex and opencode are combined (both write AGENTS.md)', () => {
    expect(() => assertNoTargetPathConflicts([TARGETS.codex, TARGETS.opencode])).toThrow(
      /both write AGENTS\.md/
    );
  });

  it('does not throw for claude + codex (no shared path)', () => {
    expect(() => assertNoTargetPathConflicts([TARGETS.claude, TARGETS.codex])).not.toThrow();
  });

  it('does not throw for a single target', () => {
    expect(() => assertNoTargetPathConflicts([TARGETS.opencode])).not.toThrow();
  });
});

describe('looksLikeConversationalNonAnswer', () => {
  it('flags the real clarifying-question artifact observed in a live run', () => {
    const observed = [
      '` tags.',
      '2. **Bring this repo\'s `AGENTS.md` into line with the `@AGENTS.md` convention** — I\'d need to first check whether `AGENTS.md` exists in this repo/worktree and migrate the current AGENTS.md content there.',
      '3. **Something else** — let me know.',
      '',
      'I\'d rather confirm than guess and hand you a file that overwrites real content incorrectly.',
      '',
      '## Skills',
    ].join('\n');
    expect(looksLikeConversationalNonAnswer(observed)).toBe(true);
  });

  it('does not flag real documentation content', () => {
    const real = '# Datalena\n\nDatalena is a chat-first data platform.\n\n## Tech Stack\n\n- Next.js\n';
    expect(looksLikeConversationalNonAnswer(real)).toBe(false);
  });

  it('flags content even when a heading appears later (e.g. the deterministically-injected Skills section)', () => {
    // Every real generated file in this repo's convention opens directly
    // with a title heading — leading prose before the first heading is
    // itself a signal something's off, and is exactly what would let a
    // conversational answer slip past a naive "contains a heading" check.
    const suspicious = 'Here is my analysis.\n\n## Skills\n\n- foo\n';
    expect(looksLikeConversationalNonAnswer(suspicious)).toBe(true);
  });

  it('flags empty content', () => {
    expect(looksLikeConversationalNonAnswer('')).toBe(true);
    expect(looksLikeConversationalNonAnswer(null)).toBe(true);
  });
});

describe('looksLikeDrasticContentLoss', () => {
  it('flags the real collapse observed live (434 lines -> 6 lines)', () => {
    const existingLength = 12000; // datalena's real AGENTS.md is well over this
    const collapsed = '@AGENTS.md\n\n## Skills\n\n- base\n'; // ~35 chars
    expect(looksLikeDrasticContentLoss(collapsed, existingLength)).toBe(true);
  });

  it('does not flag a reasonable condensation', () => {
    const existingLength = 1000;
    const condensed = 'x'.repeat(500); // 50% retained
    expect(looksLikeDrasticContentLoss(condensed, existingLength)).toBe(false);
  });

  it('does not flag when there was little existing content to begin with', () => {
    // Below the 500-char floor -- not enough of a baseline to judge fairly.
    expect(looksLikeDrasticContentLoss('short', 200)).toBe(false);
  });

  it('respects a custom minRatio', () => {
    const existingLength = 1000;
    const content = 'x'.repeat(400); // 40% retained
    expect(looksLikeDrasticContentLoss(content, existingLength, 0.3)).toBe(false);
    expect(looksLikeDrasticContentLoss(content, existingLength, 0.5)).toBe(true);
  });
});

describe('buildOutputFilesForTargets — codex-only run must never emit CLAUDE.md', () => {
  it('excludes the canonical CLAUDE.md entry when only codex is an active target', () => {
    const scan = scanRepo(FIXTURES_DIR);
    const canonicalFiles = [
      { path: '.claude/skills/base/skill.md', content: '---\nname: base\n---\nbase content' },
      { path: 'CLAUDE.md', content: '# Test\n\nsome content' },
    ];

    const out = buildOutputFilesForTargets(canonicalFiles, [TARGETS.codex], scan, null, FIXTURES_DIR);
    const paths = out.map(f => f.path);

    expect(paths).not.toContain('CLAUDE.md');
    expect(paths).toContain('AGENTS.md');
  });
});

describe('targetHasSubstantiveInstructions', () => {
  it('returns false for a missing file', () => {
    expect(targetHasSubstantiveInstructions(FIXTURES_DIR, TARGETS.claude)).toBe(false);
  });

  it('returns false for a stub import', () => {
    writeFileSync(join(FIXTURES_DIR, 'CLAUDE.md'), '@AGENTS.md\n', 'utf8');
    expect(targetHasSubstantiveInstructions(FIXTURES_DIR, TARGETS.claude)).toBe(false);
  });

  it('returns true for real content', () => {
    writeFileSync(join(FIXTURES_DIR, 'CLAUDE.md'), '# Real content here\n', 'utf8');
    expect(targetHasSubstantiveInstructions(FIXTURES_DIR, TARGETS.claude)).toBe(true);
  });
});
