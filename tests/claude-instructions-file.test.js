import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  TARGETS,
  CLAUDE_INSTRUCTIONS_FILES,
  isAgentsMdShim,
  detectClaudeInstructionsFile,
  resolveClaudeTarget,
  readConfig,
  writeConfig,
  inferConfig,
  loadConfig,
} from '../src/lib/target.js';

let repo;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'aspens-instr-'));
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const write = (rel, content) => {
  const p = join(repo, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
};
const readJson = rel => JSON.parse(readFileSync(join(repo, rel), 'utf8'));

describe('CLAUDE_INSTRUCTIONS_FILES', () => {
  it('lists exactly CLAUDE.md and AGENTS.md', () => {
    expect(CLAUDE_INSTRUCTIONS_FILES).toEqual(['CLAUDE.md', 'AGENTS.md']);
  });
});

describe('isAgentsMdShim', () => {
  it('detects a bare @AGENTS.md line', () => {
    expect(isAgentsMdShim('@AGENTS.md')).toBe(true);
    expect(isAgentsMdShim('@AGENTS.md\n')).toBe(true);
  });

  it('ignores surrounding blank lines and whitespace', () => {
    expect(isAgentsMdShim('\n\n  @AGENTS.md  \n\n\n')).toBe(true);
    expect(isAgentsMdShim('\r\n@AGENTS.md\r\n')).toBe(true);
  });

  it('ignores HTML comments, including multi-line ones', () => {
    expect(isAgentsMdShim('<!-- managed by aspens -->\n@AGENTS.md\n')).toBe(true);
    expect(isAgentsMdShim('<!--\n  see AGENTS.md\n  for details\n-->\n@AGENTS.md\n<!-- end -->')).toBe(true);
  });

  it('accepts the @./AGENTS.md form', () => {
    expect(isAgentsMdShim('@./AGENTS.md')).toBe(true);
    expect(isAgentsMdShim('\n@./AGENTS.md\n')).toBe(true);
  });

  it('tolerates a leading BOM', () => {
    expect(isAgentsMdShim('﻿@AGENTS.md\n')).toBe(true);
  });

  it('rejects content with anything beyond the import', () => {
    expect(isAgentsMdShim('# Project\n@AGENTS.md')).toBe(false);
    expect(isAgentsMdShim('@AGENTS.md\nSome extra prose.')).toBe(false);
    expect(isAgentsMdShim('@AGENTS.md\n@AGENTS.md')).toBe(false);
    expect(isAgentsMdShim('@AGENTS.md @other.md')).toBe(false);
  });

  it('rejects imports of other files or non-import lines', () => {
    expect(isAgentsMdShim('@CLAUDE.md')).toBe(false);
    expect(isAgentsMdShim('@docs/AGENTS.md')).toBe(false);
    expect(isAgentsMdShim('@agents.md')).toBe(false);
    expect(isAgentsMdShim('AGENTS.md')).toBe(false);
    expect(isAgentsMdShim('See @AGENTS.md')).toBe(false);
  });

  it('rejects empty, comment-only, and non-string input', () => {
    expect(isAgentsMdShim('')).toBe(false);
    expect(isAgentsMdShim('\n\n')).toBe(false);
    expect(isAgentsMdShim('<!-- only a comment -->')).toBe(false);
    expect(isAgentsMdShim(null)).toBe(false);
    expect(isAgentsMdShim(undefined)).toBe(false);
    expect(isAgentsMdShim(42)).toBe(false);
  });
});

describe('detectClaudeInstructionsFile', () => {
  it('returns CLAUDE.md when CLAUDE.md has real content', () => {
    write('CLAUDE.md', '# Project\n\nInstructions here.\n');
    write('AGENTS.md', '# Agents\n');
    expect(detectClaudeInstructionsFile(repo)).toBe('CLAUDE.md');
  });

  it('returns AGENTS.md when CLAUDE.md is an @AGENTS.md shim', () => {
    write('CLAUDE.md', '<!-- shim -->\n\n@AGENTS.md\n');
    expect(detectClaudeInstructionsFile(repo)).toBe('AGENTS.md');
  });

  it('returns AGENTS.md when CLAUDE.md is an @./AGENTS.md shim', () => {
    write('CLAUDE.md', '@./AGENTS.md\n');
    expect(detectClaudeInstructionsFile(repo)).toBe('AGENTS.md');
  });

  it('returns CLAUDE.md when the shim has extra content', () => {
    write('CLAUDE.md', '@AGENTS.md\n\n## Extra\n');
    expect(detectClaudeInstructionsFile(repo)).toBe('CLAUDE.md');
  });

  it('returns AGENTS.md when only AGENTS.md exists', () => {
    write('AGENTS.md', '# Agents\n');
    expect(detectClaudeInstructionsFile(repo)).toBe('AGENTS.md');
  });

  it('returns CLAUDE.md when neither file exists', () => {
    expect(detectClaudeInstructionsFile(repo)).toBe('CLAUDE.md');
  });

  it('returns CLAUDE.md when CLAUDE.md is empty', () => {
    write('CLAUDE.md', '');
    write('AGENTS.md', '# Agents\n');
    expect(detectClaudeInstructionsFile(repo)).toBe('CLAUDE.md');
  });

  it('ignores .aspens.json entirely', () => {
    write('.aspens.json', JSON.stringify({ targets: ['claude'], backend: null, version: '1.0', instructionsFile: 'AGENTS.md' }));
    write('CLAUDE.md', '# Real content\n');
    expect(detectClaudeInstructionsFile(repo)).toBe('CLAUDE.md');
  });
});

describe('resolveClaudeTarget precedence', () => {
  it('defaults to CLAUDE.md with no override, config, or files', () => {
    const t = resolveClaudeTarget(repo);
    expect(t.instructionsFile).toBe('CLAUDE.md');
    expect(t.id).toBe('claude');
  });

  it('falls back to on-disk detection when no config', () => {
    write('CLAUDE.md', '@AGENTS.md\n');
    expect(resolveClaudeTarget(repo).instructionsFile).toBe('AGENTS.md');
  });

  it('config beats on-disk detection', () => {
    write('CLAUDE.md', '# Real content\n');
    write('.aspens.json', JSON.stringify({ targets: ['claude'], backend: null, version: '1.0', instructionsFile: 'AGENTS.md' }));
    expect(resolveClaudeTarget(repo).instructionsFile).toBe('AGENTS.md');
  });

  it('explicit override beats config and detection', () => {
    write('CLAUDE.md', '@AGENTS.md\n');
    write('.aspens.json', JSON.stringify({ targets: ['claude'], backend: null, version: '1.0', instructionsFile: 'AGENTS.md' }));
    expect(resolveClaudeTarget(repo, { instructionsFile: 'CLAUDE.md' }).instructionsFile).toBe('CLAUDE.md');
  });

  it('accepts AGENTS.md as an explicit override', () => {
    write('CLAUDE.md', '# Real content\n');
    expect(resolveClaudeTarget(repo, { instructionsFile: 'AGENTS.md' }).instructionsFile).toBe('AGENTS.md');
  });

  it('treats undefined and null override as "no override"', () => {
    write('CLAUDE.md', '@AGENTS.md\n');
    expect(resolveClaudeTarget(repo, { instructionsFile: undefined }).instructionsFile).toBe('AGENTS.md');
    expect(resolveClaudeTarget(repo, { instructionsFile: null }).instructionsFile).toBe('AGENTS.md');
  });

  it('throws on an invalid override', () => {
    expect(() => resolveClaudeTarget(repo, { instructionsFile: 'README.md' })).toThrow(/Invalid instructions file: "README.md"/);
    expect(() => resolveClaudeTarget(repo, { instructionsFile: 'agents.md' })).toThrow(/Valid values: CLAUDE\.md, AGENTS\.md/);
    expect(() => resolveClaudeTarget(repo, { instructionsFile: '' })).toThrow(/Invalid instructions file/);
  });

  it('ignores invalid config instructionsFile and falls back to detection', () => {
    write('AGENTS.md', '# Agents\n');
    write('.aspens.json', JSON.stringify({ targets: ['claude'], backend: null, version: '1.0', instructionsFile: 'README.md' }));
    expect(readConfig(repo)).toBeNull();
    expect(resolveClaudeTarget(repo).instructionsFile).toBe('AGENTS.md');
  });

  it('never mutates TARGETS.claude and returns a fresh object', () => {
    write('CLAUDE.md', '@AGENTS.md\n');
    const a = resolveClaudeTarget(repo);
    const b = resolveClaudeTarget(repo, { instructionsFile: 'CLAUDE.md' });
    expect(a).not.toBe(TARGETS.claude);
    expect(a).not.toBe(b);
    expect(TARGETS.claude.instructionsFile).toBe('CLAUDE.md');
    expect(a.configDir).toBe(TARGETS.claude.configDir);
    expect(a.skillsDir).toBe(TARGETS.claude.skillsDir);
  });
});

describe('.aspens.json instructionsFile validation', () => {
  it('reads a valid instructionsFile', () => {
    write('.aspens.json', JSON.stringify({ targets: ['claude'], backend: null, version: '1.0', instructionsFile: 'AGENTS.md' }));
    expect(readConfig(repo)?.instructionsFile).toBe('AGENTS.md');
  });

  it('accepts a config with no instructionsFile', () => {
    write('.aspens.json', JSON.stringify({ targets: ['claude'], backend: null, version: '1.0' }));
    const cfg = readConfig(repo);
    expect(cfg).not.toBeNull();
    expect(cfg.instructionsFile).toBeUndefined();
  });

  it('rejects an invalid instructionsFile value', () => {
    write('.aspens.json', JSON.stringify({ targets: ['claude'], backend: null, version: '1.0', instructionsFile: 'OTHER.md' }));
    expect(readConfig(repo)).toBeNull();
  });

  it('rejects a non-string instructionsFile', () => {
    write('.aspens.json', JSON.stringify({ targets: ['claude'], backend: null, version: '1.0', instructionsFile: 3 }));
    expect(readConfig(repo)).toBeNull();
  });

  it('returns null for corrupt JSON', () => {
    write('.aspens.json', '{ not json');
    expect(readConfig(repo)).toBeNull();
  });
});

describe('writeConfig instructionsFile persistence', () => {
  it('writes instructionsFile when provided', () => {
    writeConfig(repo, { targets: ['claude'], instructionsFile: 'AGENTS.md' });
    expect(readJson('.aspens.json')).toEqual({ targets: ['claude'], backend: null, version: '1.0', instructionsFile: 'AGENTS.md' });
  });

  it('omits instructionsFile when not provided and none existed', () => {
    writeConfig(repo, { targets: ['claude'] });
    expect(readJson('.aspens.json')).not.toHaveProperty('instructionsFile');
  });

  it('preserves an existing instructionsFile across rewrites', () => {
    writeConfig(repo, { targets: ['claude'], instructionsFile: 'AGENTS.md' });
    writeConfig(repo, { targets: ['claude', 'codex'], backend: 'claude' });
    const cfg = readJson('.aspens.json');
    expect(cfg.instructionsFile).toBe('AGENTS.md');
    expect(cfg.targets).toEqual(['claude', 'codex']);
    expect(cfg.backend).toBe('claude');
  });

  it('preserves saveTokens alongside instructionsFile', () => {
    const saveTokens = { enabled: true, warnAtTokens: 100, compactAtTokens: 200, saveHandoff: false, sessionRotation: false };
    writeConfig(repo, { targets: ['claude'], saveTokens, instructionsFile: 'AGENTS.md' });
    writeConfig(repo, { targets: ['claude'] });
    const cfg = readJson('.aspens.json');
    expect(cfg.saveTokens).toEqual(saveTokens);
    expect(cfg.instructionsFile).toBe('AGENTS.md');
  });

  it('overwrites instructionsFile with a new valid value', () => {
    writeConfig(repo, { targets: ['claude'], instructionsFile: 'AGENTS.md' });
    writeConfig(repo, { targets: ['claude'], instructionsFile: 'CLAUDE.md' });
    expect(readJson('.aspens.json').instructionsFile).toBe('CLAUDE.md');
  });

  it('drops instructionsFile when explicitly passed null', () => {
    writeConfig(repo, { targets: ['claude'], instructionsFile: 'AGENTS.md' });
    writeConfig(repo, { targets: ['claude'], instructionsFile: null });
    expect(readJson('.aspens.json')).not.toHaveProperty('instructionsFile');
  });

  it('throws on an invalid instructionsFile and leaves the file untouched', () => {
    writeConfig(repo, { targets: ['claude'], instructionsFile: 'AGENTS.md' });
    expect(() => writeConfig(repo, { targets: ['claude'], instructionsFile: 'nope.md' })).toThrow(/Invalid instructions file/);
    expect(readJson('.aspens.json').instructionsFile).toBe('AGENTS.md');
  });

  it('recovers from a corrupt existing config without throwing', () => {
    write('.aspens.json', '{{{');
    writeConfig(repo, { targets: ['claude'], instructionsFile: 'AGENTS.md' });
    expect(readJson('.aspens.json')).toEqual({ targets: ['claude'], backend: null, version: '1.0', instructionsFile: 'AGENTS.md' });
  });
});

describe('inferConfig instructionsFile recovery', () => {
  it('records AGENTS.md when CLAUDE.md is a shim', () => {
    mkdirSync(join(repo, '.claude/skills'), { recursive: true });
    write('CLAUDE.md', '@AGENTS.md\n');
    write('AGENTS.md', '# Agents\n');
    const cfg = inferConfig(repo);
    expect(cfg.targets).toContain('claude');
    expect(cfg.instructionsFile).toBe('AGENTS.md');
  });

  it('records AGENTS.md when only AGENTS.md plus .claude exists', () => {
    mkdirSync(join(repo, '.claude'), { recursive: true });
    write('AGENTS.md', '# Agents\n');
    const cfg = inferConfig(repo);
    expect(cfg.targets).toContain('claude');
    expect(cfg.instructionsFile).toBe('AGENTS.md');
  });

  it('omits instructionsFile when CLAUDE.md carries real content', () => {
    write('CLAUDE.md', '# Real\n');
    const cfg = inferConfig(repo);
    expect(cfg.targets).toEqual(['claude']);
    expect(cfg).not.toHaveProperty('instructionsFile');
  });

  it('omits instructionsFile when only .claude exists with no instructions file', () => {
    mkdirSync(join(repo, '.claude'), { recursive: true });
    const cfg = inferConfig(repo);
    expect(cfg.targets).toEqual(['claude']);
    expect(cfg).not.toHaveProperty('instructionsFile');
  });

  it('omits instructionsFile for a codex-only repo', () => {
    mkdirSync(join(repo, '.codex'), { recursive: true });
    write('AGENTS.md', '# Agents\n');
    const cfg = inferConfig(repo);
    expect(cfg.targets).toEqual(['codex']);
    expect(cfg).not.toHaveProperty('instructionsFile');
  });

  it('returns null when no artifacts exist', () => {
    expect(inferConfig(repo)).toBeNull();
  });

  it('loadConfig persists the recovered instructionsFile', () => {
    mkdirSync(join(repo, '.claude'), { recursive: true });
    write('CLAUDE.md', '<!-- shim -->\n@./AGENTS.md\n');
    write('AGENTS.md', '# Agents\n');
    const { config, recovered } = loadConfig(repo);
    expect(recovered).toBe(true);
    expect(config.instructionsFile).toBe('AGENTS.md');
    expect(existsSync(join(repo, '.aspens.json'))).toBe(true);
    expect(readJson('.aspens.json').instructionsFile).toBe('AGENTS.md');
    expect(resolveClaudeTarget(repo).instructionsFile).toBe('AGENTS.md');
  });

  it('loadConfig with persist:false does not write .aspens.json', () => {
    mkdirSync(join(repo, '.claude'), { recursive: true });
    write('AGENTS.md', '# Agents\n');
    const { config, recovered } = loadConfig(repo, { persist: false });
    expect(recovered).toBe(true);
    expect(config.instructionsFile).toBe('AGENTS.md');
    expect(existsSync(join(repo, '.aspens.json'))).toBe(false);
  });

  it('loadConfig recovers when .aspens.json is corrupt', () => {
    write('.aspens.json', 'garbage');
    write('CLAUDE.md', '@AGENTS.md\n');
    const { config, recovered } = loadConfig(repo);
    expect(recovered).toBe(true);
    expect(config.instructionsFile).toBe('AGENTS.md');
  });
});
