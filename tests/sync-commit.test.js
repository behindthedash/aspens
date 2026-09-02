import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { commitSyncOutput, SYNC_COMMIT_MESSAGE } from '../src/lib/sync-commit.js';

const REPO = join(import.meta.dirname, 'tmp-sync-commit');
const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeEach(() => {
  if (existsSync(REPO)) rmSync(REPO, { recursive: true, force: true });
  mkdirSync(REPO, { recursive: true });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(REPO, 'index.js'), 'export {};\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
});

afterAll(() => {
  if (existsSync(REPO)) rmSync(REPO, { recursive: true, force: true });
});

describe('commitSyncOutput', () => {
  it('commits only the written docs and leaves other dirty files alone', () => {
    writeFileSync(join(REPO, 'AGENTS.md'), '# generated\n');
    mkdirSync(join(REPO, '.claude', 'skills', 'base'), { recursive: true });
    writeFileSync(join(REPO, '.claude', 'skills', 'base', 'SKILL.md'), '# base\n');
    writeFileSync(join(REPO, 'index.js'), 'export const x = 1;\n'); // unrelated edit

    const result = commitSyncOutput(REPO, REPO, ['AGENTS.md', '.claude/skills/base/SKILL.md']);

    expect(result.committed).toBe(true);
    expect(git('log', '-1', '--pretty=%s')).toBe(SYNC_COMMIT_MESSAGE);
    expect(git('show', '--name-only', '--pretty=', 'HEAD').split('\n').sort())
      .toEqual(['.claude/skills/base/SKILL.md', 'AGENTS.md']);
    expect(git('status', '--porcelain', '--untracked-files=all')).toBe(' M index.js'.trimStart());
    expect(git('diff', '--cached', '--name-only')).toBe('');
  });

  it('resolves subproject paths relative to the git root', () => {
    mkdirSync(join(REPO, 'backend'), { recursive: true });
    writeFileSync(join(REPO, 'backend', 'AGENTS.md'), '# backend\n');

    const result = commitSyncOutput(REPO, join(REPO, 'backend'), ['AGENTS.md']);

    expect(result.committed).toBe(true);
    expect(git('show', '--name-only', '--pretty=', 'HEAD')).toBe('backend/AGENTS.md');
  });

  it('reports nothing to commit when the written files match HEAD', () => {
    const result = commitSyncOutput(REPO, REPO, ['index.js']);

    expect(result.committed).toBe(false);
    expect(result.error).toBe('nothing to commit');
    expect(git('log', '--oneline').split('\n')).toHaveLength(1);
  });

  it('returns the git error instead of throwing when the commit cannot land', () => {
    writeFileSync(join(REPO, 'AGENTS.md'), '# generated\n');
    writeFileSync(join(REPO, '.git', 'index.lock'), ''); // another git process holds the index

    const result = commitSyncOutput(REPO, REPO, ['AGENTS.md']);

    expect(result.committed).toBe(false);
    expect(result.error).toMatch(/index\.lock|Unable to create/);
  });
});
