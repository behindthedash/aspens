import { describe, it, expect } from 'vitest';
import { parseFrontmatter, readFrontmatterScalar } from '../src/lib/skill-reader.js';
import { syncSkillsSection } from '../src/lib/target-transform.js';
import { TARGETS } from '../src/lib/target.js';

const folded = [
  '---',
  'name: architecture',
  'description: >',
  '  Use when modifying imports, creating new files, refactoring modules,',
  '  or understanding how components relate. Not needed for simple single-file edits.',
  '---',
  '',
  '# Architecture',
].join('\n');

describe('readFrontmatterScalar', () => {
  it('folds a `>` block scalar into one line instead of returning a bare `>`', () => {
    const block = folded.split('\n').slice(1, 5).join('\n');
    expect(readFrontmatterScalar(block, 'description')).toBe(
      'Use when modifying imports, creating new files, refactoring modules, or understanding how components relate. Not needed for simple single-file edits.',
    );
  });

  it('handles literal `|` blocks, chomping indicators, and blank lines', () => {
    expect(readFrontmatterScalar('description: |-\n  first\n\n  second\nname: x', 'description')).toBe('first second');
    expect(readFrontmatterScalar('description: >+\n  only\nname: x', 'name')).toBe('x');
  });

  it('still reads plain and quoted scalars', () => {
    expect(readFrontmatterScalar('description: plain text here', 'description')).toBe('plain text here');
    expect(readFrontmatterScalar('description: "quoted: text"', 'description')).toBe('quoted: text');
    expect(readFrontmatterScalar("description: 'single'", 'description')).toBe('single');
  });

  it('does not match a longer key that merely starts with the field name', () => {
    expect(readFrontmatterScalar('description_extra: nope\nname: x', 'description')).toBeNull();
  });
});

describe('parseFrontmatter with block scalars', () => {
  it('returns the folded description', () => {
    expect(parseFrontmatter(folded)).toEqual({
      name: 'architecture',
      description: 'Use when modifying imports, creating new files, refactoring modules, or understanding how components relate. Not needed for simple single-file edits.',
    });
  });
});

describe('syncSkillsSection with a block-scalar description', () => {
  it('renders the folded description in the Skills index, never a bare `>`', () => {
    const target = TARGETS.codex;
    const domainSkills = [{ path: `${target.skillsDir}/architecture/${target.skillFilename}`, content: folded }];
    const out = syncSkillsSection('# Repo\n\n## Skills\n\n- old\n\n## Other\n\nbody\n', null, domainSkills, target, false);
    expect(out).not.toMatch(/— >\s*$/m);
    expect(out).toContain('— Use when modifying imports, creating new files, refactoring modules, or understanding how components relate.');
  });
});
