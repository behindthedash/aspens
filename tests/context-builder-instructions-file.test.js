import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildContext } from '../src/lib/context-builder.js';

const SCAN_RESULT = {
  name: 'fixture',
  repoType: 'node',
  frameworks: [],
  entryPoints: [],
  domains: [],
  structure: { keyDirs: {} },
};

const AGENTS_BODY = '# Agents instructions\nAGENTS_MARKER_CONTENT';
const CLAUDE_FULL_BODY = '# Claude instructions\nCLAUDE_MARKER_CONTENT';
const CLAUDE_SHIM_BODY = '@AGENTS.md\n';

function sectionIndex(context, name) {
  return context.indexOf(`## Existing ${name}\n`);
}

describe('buildContext existing instructions sections', () => {
  let repoPath;

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), 'aspens-ctx-instr-'));
  });

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  it('emits AGENTS.md as primary followed by CLAUDE.md alternative for a shim repo', () => {
    writeFileSync(join(repoPath, 'CLAUDE.md'), CLAUDE_SHIM_BODY);
    writeFileSync(join(repoPath, 'AGENTS.md'), AGENTS_BODY);

    const context = buildContext(repoPath, SCAN_RESULT);

    const agentsIdx = sectionIndex(context, 'AGENTS.md');
    const claudeIdx = sectionIndex(context, 'CLAUDE.md');
    expect(agentsIdx).toBeGreaterThanOrEqual(0);
    expect(claudeIdx).toBeGreaterThanOrEqual(0);
    expect(agentsIdx).toBeLessThan(claudeIdx);

    expect(context).toContain(`## Existing AGENTS.md\n\`\`\`markdown\n${AGENTS_BODY}\n\`\`\``);
    expect(context).toContain(`## Existing CLAUDE.md\n\`\`\`markdown\n${CLAUDE_SHIM_BODY}\n\`\`\``);
    expect(context.match(/## Existing /g)).toHaveLength(2);
  });

  it('emits CLAUDE.md as primary followed by AGENTS.md alternative for a CLAUDE.md repo', () => {
    writeFileSync(join(repoPath, 'CLAUDE.md'), CLAUDE_FULL_BODY);
    writeFileSync(join(repoPath, 'AGENTS.md'), AGENTS_BODY);

    const context = buildContext(repoPath, SCAN_RESULT);

    const agentsIdx = sectionIndex(context, 'AGENTS.md');
    const claudeIdx = sectionIndex(context, 'CLAUDE.md');
    expect(agentsIdx).toBeGreaterThanOrEqual(0);
    expect(claudeIdx).toBeGreaterThanOrEqual(0);
    expect(claudeIdx).toBeLessThan(agentsIdx);

    expect(context).toContain(`## Existing CLAUDE.md\n\`\`\`markdown\n${CLAUDE_FULL_BODY}\n\`\`\``);
    expect(context).toContain(`## Existing AGENTS.md\n\`\`\`markdown\n${AGENTS_BODY}\n\`\`\``);
    expect(context.match(/## Existing /g)).toHaveLength(2);
  });

  it('honors .aspens.json instructionsFile over on-disk detection', () => {
    writeFileSync(join(repoPath, 'CLAUDE.md'), CLAUDE_FULL_BODY);
    writeFileSync(join(repoPath, 'AGENTS.md'), AGENTS_BODY);
    writeFileSync(
      join(repoPath, '.aspens.json'),
      JSON.stringify({ targets: ['claude'], backend: 'claude', version: '1', instructionsFile: 'AGENTS.md' })
    );

    const context = buildContext(repoPath, SCAN_RESULT);

    expect(sectionIndex(context, 'AGENTS.md')).toBeLessThan(sectionIndex(context, 'CLAUDE.md'));
  });

  it('emits only the primary section when the alternative is absent', () => {
    writeFileSync(join(repoPath, 'CLAUDE.md'), CLAUDE_FULL_BODY);

    const context = buildContext(repoPath, SCAN_RESULT);

    expect(context).toContain('## Existing CLAUDE.md\n');
    expect(context).not.toContain('## Existing AGENTS.md');
  });
});
