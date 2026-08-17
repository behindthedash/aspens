import { describe, it, expect } from 'vitest';
import { parseLLMOutput, autoTimeout } from '../src/commands/doc-init.js';

// Regression for "OpenCode has no tag-following fallback, unlike Claude and
// Codex" — parseLLMOutput's untagged-text wrap previously could never fire
// for any backend: it gated on an `allowedPaths`-shape heuristic
// (isSingleFilePrompt) that was always false in the real call sites, since
// canonical generation always calls it with `allowedPaths: null`. Replaced
// with an explicit `singleFile` flag each call site already knows statically.
describe('parseLLMOutput — untagged-text fallback', () => {
  it('wraps raw untagged text as the expected file on a single-file prompt', () => {
    const text = '# base skill\nsome content with no tags at all, well past the length floor';
    const files = parseLLMOutput(text, null, '.claude/skills/base/skill.md', true);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('.claude/skills/base/skill.md');
    expect(files[0].content).toBe(text + '\n');
  });

  it('does not wrap untagged text on a multi-file prompt (all-at-once mode)', () => {
    const files = parseLLMOutput('# base skill\nsome content with no tags', null, 'CLAUDE.md', false);
    expect(files).toHaveLength(0);
  });

  it('defaults singleFile to false when the caller omits it', () => {
    const files = parseLLMOutput('# base skill\nsome content with no tags', null, 'CLAUDE.md');
    expect(files).toHaveLength(0);
  });

  it('still parses real <file> tags normally on a single-file prompt (no double-wrap)', () => {
    const output = '<file path="CLAUDE.md">\n# My App\n</file>';
    const files = parseLLMOutput(output, null, 'CLAUDE.md', true);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('CLAUDE.md');
    expect(files[0].content.trim()).toBe('# My App');
  });

  it('does not wrap short/empty text (likely a stray token, not real content)', () => {
    const files = parseLLMOutput('ok', null, 'CLAUDE.md', true);
    expect(files).toHaveLength(0);
  });
});

// Regression for "default 300s per-call timeout is too short for OpenCode's
// agentic-loop overhead on large repos" — OpenCode's tool-calling loop adds
// wall-clock time beyond model latency that Claude/Codex's more restricted
// execution doesn't incur, so its size-based default gets a multiplier.
describe('autoTimeout — backend-aware scaling', () => {
  it('applies a multiplier to the size-based default for the opencode backend', () => {
    const scan = { size: { category: 'very-large' } };
    const claudeMs = autoTimeout(scan, undefined, 'claude');
    const opencodeMs = autoTimeout(scan, undefined, 'opencode');
    expect(claudeMs).toBe(900000);
    expect(opencodeMs).toBeGreaterThan(claudeMs);
    expect(opencodeMs).toBe(1350000);
  });

  it('leaves codex and claude on the plain size-based default', () => {
    const scan = { size: { category: 'large' } };
    expect(autoTimeout(scan, undefined, 'claude')).toBe(600000);
    expect(autoTimeout(scan, undefined, 'codex')).toBe(600000);
  });

  it('an explicit --timeout flag still wins over the opencode multiplier', () => {
    const scan = { size: { category: 'very-large' } };
    expect(autoTimeout(scan, 60, 'opencode')).toBe(60000);
  });
});
