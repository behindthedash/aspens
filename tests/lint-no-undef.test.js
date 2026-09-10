import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO_ROOT = join(import.meta.dirname, '..');
const OXLINT = join(REPO_ROOT, 'node_modules', '.bin', 'oxlint');
const CONFIG = join(REPO_ROOT, '.oxlintrc.json');

function lint(source) {
  const dir = mkdtempSync(join(tmpdir(), 'aspens-lint-'));
  try {
    const file = join(dir, 'sample.js');
    writeFileSync(file, source);
    const result = spawnSync(OXLINT, ['-c', CONFIG, file], { encoding: 'utf8' });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('npm run lint enforces no-undef', () => {
  it('fails on a reference to an identifier that was never imported', () => {
    // Mirrors the shipped defect: BACKENDS used in doc-init.js without its import.
    const { status, output } = lint('export function ids() { return Object.keys(BACKENDS); }\n');
    expect(status).not.toBe(0);
    expect(output).toContain('no-undef');
    expect(output).toContain("'BACKENDS' is not defined");
  });

  it('accepts Node and ES globals used throughout src/', () => {
    const { status, output } = lint(
      "console.log(process.cwd(), Buffer.from('x'), URL, structuredClone({}));\n"
    );
    expect(output).not.toContain('no-undef');
    expect(status).toBe(0);
  });
});
