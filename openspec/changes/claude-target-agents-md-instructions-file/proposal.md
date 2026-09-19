## Why

The `claude` target hardcodes its root instructions file to `CLAUDE.md` (`src/lib/target.js:21`), and every claude-target run creates or refreshes that file: `transformForTarget` writes the root file to `destTarget.instructionsFile` (`src/lib/target-transform.js:89`), doc-init parses the LLM output as `CLAUDE.md`, and `ensureAspensImportBlock` appends the `@.claude/aspens-index.md` block to it. Repos that keep their real instructions in `AGENTS.md` — either with a one-line `@AGENTS.md` shim in `CLAUDE.md`, or with no `CLAUDE.md` at all now that Claude Code loads `AGENTS.md` natively — get the wrong outcome: aspens either overwrites the shim with a full generated `CLAUDE.md`, or creates a second, competing instructions file next to the hand-authored `AGENTS.md`. There is no `--instructions-file` option to steer this (`grep -rln instructions-file src bin` is empty), and the only prior AGENTS.md work (PRs #5, #11) covered multi-target clobbering, not claude-target output.

## What Changes

- Add an instructions-file resolver for the claude target that picks `AGENTS.md` instead of `CLAUDE.md` when the repo already uses `AGENTS.md` as its Claude instructions surface: `CLAUDE.md` is absent and `AGENTS.md` exists, or `CLAUDE.md` is a pure `@AGENTS.md` import shim. Fresh repos with neither file keep the `CLAUDE.md` default.
- Add a `--instructions-file <name>` option to `aspens doc init` (`CLAUDE.md` or `AGENTS.md`) that overrides detection.
- Persist the resolved file name in `.aspens.json` so `doc sync`, `doc impact`, and the post-commit hook path all operate on the same file without re-detecting.
- Thread the resolved file through doc-init's root-instructions generation (prompt label, expected `<file path>`, allowed paths, retry messages, `ensureAspensImportBlock` write site), doc-sync's deterministic repair and LLM sync paths, context-builder's existing-instructions loading, and doc-impact's freshness summary.
- Leave a detected `@AGENTS.md` shim in `CLAUDE.md` byte-for-byte untouched; the aspens import block goes into `AGENTS.md`, relying on Claude Code's recursive `@path` import.
- Codex and opencode targets are unaffected; their `AGENTS.md` handling and `ensureAspensManagedBlock` inline behavior stay as-is.

## Capabilities

### New Capabilities
- `claude-instructions-file-resolution`: how the claude target decides whether its root instructions file is `CLAUDE.md` or `AGENTS.md` (detection rules, explicit override, persistence in `.aspens.json`).
- `claude-instructions-file-output`: how doc-init, doc-sync, doc-impact, and context building honor the resolved file name instead of the hardcoded `CLAUDE.md`, including shim preservation.

### Modified Capabilities
<!-- none: openspec/specs/ is empty in this repo; both capabilities are new -->

## Impact

- `src/lib/target.js` — new resolver + `instructionsFile` field in `.aspens.json` validation/persistence; `inferConfig` records `AGENTS.md` for AGENTS.md-only claude repos.
- `src/commands/doc-init.js` — `CANONICAL_VARS`, `instructionsArtifactLabel`, the `parseLLMOutput(..., 'CLAUDE.md', ...)` calls, retry prompts, and the `ensureAspensImportBlock` write site switch to the resolved name; new CLI option wiring in `bin/cli.js`.
- `src/commands/doc-sync.js`, `src/lib/context-builder.js`, `src/lib/impact.js`, `src/commands/doc-impact.js` — replace `|| 'CLAUDE.md'` fallbacks and static `TARGETS.claude` lookups with the resolved target.
- `src/prompts/doc-init-claudemd.md` — output-path references become the existing `instructionsFile` variable.
- Tests under `tests/` for resolver, config persistence, doc-init output path, doc-sync repair, context building, impact summary, and a literal guard.
- No change to codex/opencode targets, skill generation, hooks, or save-tokens.
