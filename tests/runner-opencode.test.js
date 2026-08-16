import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join, delimiter } from 'path';
import { runOpenCode } from '../src/lib/runner.js';

const FAKE_BIN_DIR = join(import.meta.dirname, 'fixtures', 'fake-bin');

let originalPath;

beforeEach(() => {
  originalPath = process.env.PATH;
  process.env.PATH = `${FAKE_BIN_DIR}${delimiter}${originalPath}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
});

// Regression: the raw-output fallback (used when no text part ever ends up
// non-empty) used to stop buffering stdout as soon as ANY text part existed,
// even one with empty content — silently truncating the fallback on runs
// where OpenCode's first text event establishes an id before real content
// arrives. Fixed by only stopping the buffer once a part has REAL (non-empty)
// text, since combined output can only be empty if no part ever got one.
describe('runOpenCode — raw-output fallback buffering', () => {
  it('does not truncate the fallback when an early text event is empty', async () => {
    const { text } = await runOpenCode('irrelevant prompt', { timeout: 10000 });
    expect(text).toContain('RAW_MARKER_XYZ');
  });
});
