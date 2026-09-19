# claude-instructions-file-output Specification

## Purpose
Defines how doc-init, doc-sync, doc-impact, and prompt context honor the resolved claude instructions file so that every read and write site agrees on one file and a hand-authored `@AGENTS.md` shim is never overwritten.
## Requirements
### Requirement: doc init generates the root instructions file under the resolved name
When the claude target resolves to `AGENTS.md`, `aspens doc init` SHALL generate, parse, validate, and write the root instructions file as `AGENTS.md`: the prompt's instructions-file variable, the expected `<file path="...">` tag, the allowed-path list, the retry messages, the spinner label, and the strategy check for an existing file SHALL all use the resolved name. No `CLAUDE.md` SHALL be created or modified in this case.

#### Scenario: LLM output path must match the resolved name
- **WHEN** the resolved file is `AGENTS.md` and the LLM emits `<file path="CLAUDE.md">`
- **THEN** the output is treated as missing file tags and the retry prompt asks for `<file path="AGENTS.md">`

#### Scenario: Aspens import block lands in AGENTS.md
- **WHEN** the resolved file is `AGENTS.md` and generation succeeds
- **THEN** `AGENTS.md` ends with the `<!-- aspens:start -->` / `@.claude/aspens-index.md` / `<!-- aspens:end -->` block and `.claude/aspens-index.md` is written

#### Scenario: Improve strategy reads the existing AGENTS.md
- **WHEN** the resolved file is `AGENTS.md`, `--strategy improve` is used, and `AGENTS.md` has existing content
- **THEN** the generation prompt includes an `## Existing AGENTS.md` section and the drastic-content-loss guard compares against `AGENTS.md`'s length

#### Scenario: Skip-existing strategy checks the resolved file
- **WHEN** the resolved file is `AGENTS.md`, `--strategy skip` is used, and `AGENTS.md` exists but `CLAUDE.md` does not
- **THEN** root-instructions generation is skipped

#### Scenario: Default behavior unchanged for CLAUDE.md repos
- **WHEN** the resolved file is `CLAUDE.md`
- **THEN** all generated paths, labels, and prompts are identical to the current behavior

### Requirement: An `@AGENTS.md` shim in CLAUDE.md is preserved byte-for-byte
When detection resolves `AGENTS.md` because `CLAUDE.md` is an `@AGENTS.md` shim, no doc-init or doc-sync path SHALL read `CLAUDE.md` as the instructions file, rewrite it, append the aspens import block to it, or strip sections from it.

#### Scenario: doc init leaves the shim alone
- **WHEN** `CLAUDE.md` contains only `@AGENTS.md` and `aspens doc init --target claude` runs to completion
- **THEN** `CLAUDE.md` is byte-identical to its pre-run content and the aspens block is in `AGENTS.md`

#### Scenario: doc sync repair leaves the shim alone
- **WHEN** `CLAUDE.md` is a shim, `.aspens.json` records `AGENTS.md`, and `aspens doc sync` runs its deterministic repair
- **THEN** `CLAUDE.md` is unchanged and any missing aspens block or stale index is repaired via `AGENTS.md`

### Requirement: doc sync operates on the persisted instructions file
All `doc sync` paths (no-diff repair, `--refresh`, LLM commit sync, and the post-commit hook invocation) SHALL read the claude instructions file name from `.aspens.json` via the resolver and SHALL NOT fall back to the literal `CLAUDE.md` when `AGENTS.md` is recorded. The existing-instructions section of the sync prompt and the pending-file lookup SHALL use the same name.

#### Scenario: Refresh updates AGENTS.md
- **WHEN** `.aspens.json` records `AGENTS.md` and `aspens doc sync --refresh` runs
- **THEN** the Skills index and aspens block are refreshed in `AGENTS.md` and `CLAUDE.md` is not created

#### Scenario: Missing recorded file is reported, not re-detected
- **WHEN** `.aspens.json` records `AGENTS.md` but `AGENTS.md` has been deleted
- **THEN** the repair pass makes no root-instructions change and does not write `CLAUDE.md`

### Requirement: Context building and impact analysis use the resolved name
`buildContext` SHALL receive the resolved instructions file for the "Existing instructions" section and SHALL treat the other name as the alternative file. `summarizeTarget` in impact analysis and the `doc impact` report SHALL report `instructionsFile`, `instructionExists`, and `lastUpdated` against the resolved name.

#### Scenario: Impact reports AGENTS.md as present
- **WHEN** `.aspens.json` records `AGENTS.md`, `AGENTS.md` exists, and `CLAUDE.md` does not
- **THEN** `aspens doc impact --json` shows `instructionsFile: "AGENTS.md"` and `instructionExists: true` for the claude target

#### Scenario: Context loads AGENTS.md as the primary existing file
- **WHEN** the resolved file is `AGENTS.md` and both `AGENTS.md` and a shim `CLAUDE.md` exist
- **THEN** the context contains `## Existing AGENTS.md` followed by `## Existing CLAUDE.md` as the alternative

### Requirement: No stray `CLAUDE.md` literals outside the resolver
Source files under `src/commands` and `src/lib` other than `src/lib/target.js` SHALL NOT contain the quoted literal `CLAUDE.md` used as an instructions-file path or fallback; they SHALL consume the resolved target's `instructionsFile`. Template and prompt text that merely mentions `CLAUDE.md` in prose is exempt.

#### Scenario: Literal guard test
- **WHEN** the test suite greps `src/commands` and `src/lib` (excluding `src/lib/target.js`) for `'CLAUDE.md'` or `"CLAUDE.md"`
- **THEN** it finds no occurrences

