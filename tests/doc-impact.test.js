import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { buildApplyPlan, buildApplyConfirmationMessage } from '../src/commands/doc-impact.js';
import { analyzeImpact } from '../src/lib/impact.js';

describe('buildApplyPlan', () => {
  it('preserves target context for target-specific init actions', () => {
    const plan = buildApplyPlan([
      {
        id: 'claude',
        actions: [
          'aspens doc init --hooks-only',
          'aspens doc init --mode base-only --strategy rewrite',
        ],
      },
      {
        id: 'codex',
        actions: [],
      },
    ]);

    expect(plan).toEqual([
      {
        action: 'aspens doc init --hooks-only',
        target: { id: 'claude', actions: ['aspens doc init --hooks-only', 'aspens doc init --mode base-only --strategy rewrite'] },
      },
      {
        action: 'aspens doc init --mode base-only --strategy rewrite',
        target: { id: 'claude', actions: ['aspens doc init --hooks-only', 'aspens doc init --mode base-only --strategy rewrite'] },
      },
    ]);
  });

  it('deduplicates repo-wide sync actions across targets', () => {
    const plan = buildApplyPlan([
      { id: 'claude', actions: ['aspens doc sync'] },
      { id: 'codex', actions: ['aspens doc sync'] },
    ]);

    expect(plan).toHaveLength(1);
    expect(plan[0].action).toBe('aspens doc sync');
  });
});

describe('buildApplyConfirmationMessage', () => {
  it('uses the explicit apply confirmation prompt', () => {
    expect(buildApplyConfirmationMessage()).toBe('Do you want to apply recommendations?');
  });
});

describe('analyzeImpact JSON report — claude instructions file resolution', () => {
  const TEST_DIR = join(import.meta.dirname, 'tmp-doc-impact');

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('reports instructionsFile AGENTS.md as present when .aspens.json records it and CLAUDE.md is absent', async () => {
    writeFileSync(join(TEST_DIR, '.aspens.json'), JSON.stringify({
      targets: ['claude'],
      backend: 'claude',
      version: '0.0.0',
      instructionsFile: 'AGENTS.md',
    }));
    writeFileSync(join(TEST_DIR, 'AGENTS.md'), '# Project\n\nReal instructions live here.\n');
    mkdirSync(join(TEST_DIR, 'src'), { recursive: true });
    writeFileSync(join(TEST_DIR, 'src', 'index.js'), 'export const x = 1;\n');

    expect(existsSync(join(TEST_DIR, 'CLAUDE.md'))).toBe(false);

    const report = await analyzeImpact(TEST_DIR, { graph: false });
    const claude = report.targets.find(t => t.id === 'claude');

    expect(claude).toBeDefined();
    expect(claude.instructionsFile).toBe('AGENTS.md');
    expect(claude.instructionExists).toBe(true);
    // Round-trips through JSON serialization exactly as the --json / analysis payload would.
    const json = JSON.parse(JSON.stringify(report.targets));
    expect(json.find(t => t.id === 'claude')).toMatchObject({
      instructionsFile: 'AGENTS.md',
      instructionExists: true,
    });
  });
});
