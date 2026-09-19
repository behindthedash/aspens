/**
 * Guard: the claude target's root instructions file is resolved per repo
 * (`resolveClaudeTarget`), so no source file outside the resolver may hard-code
 * the quoted literal `CLAUDE.md` as an instructions-file path or fallback.
 * Prose in comments and prompt templates is exempt (only quoted literals count).
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = join(import.meta.dirname, '..');
const SCAN_DIRS = ['src/commands', 'src/lib'];
const RESOLVER = join('src', 'lib', 'target.js');
const QUOTED_LITERAL = /(['"])CLAUDE\.md\1/;

function jsFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return jsFiles(full);
    return full.endsWith('.js') ? [full] : [];
  });
}

describe('no stray CLAUDE.md literals outside the resolver', () => {
  it("finds no 'CLAUDE.md' or \"CLAUDE.md\" in src/commands or src/lib except src/lib/target.js", () => {
    const hits = [];
    for (const dir of SCAN_DIRS) {
      for (const file of jsFiles(join(ROOT, dir))) {
        const rel = relative(ROOT, file);
        if (rel === RESOLVER) continue;
        readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          if (QUOTED_LITERAL.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });
});
