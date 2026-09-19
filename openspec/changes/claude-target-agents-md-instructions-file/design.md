## Context

The claude target definition is a static object (`TARGETS.claude`) whose `instructionsFile` is read in roughly 30 places across doc-init, doc-sync, doc-impact, context-builder, impact, and target-transform. Several of those sites also carry a literal `'CLAUDE.md'` fallback or string (`CANONICAL_VARS`, `parseLLMOutput(..., 'CLAUDE.md', true)`, `instructionsArtifactLabel`, `claudeMdExists`, retry prompt text, `context-builder.js:116`, `doc-sync.js:128/449/741/822`). Claude Code loads `AGENTS.md` natively when no `CLAUDE.md` exists, and `@path` imports are recursive, so an `@.claude/aspens-index.md` block inside an `AGENTS.md` reached via a `CLAUDE.md` shim still resolves. `.aspens.json` currently stores only `targets`, `backend`, `version`, and `saveTokens`.

## Goals / Non-Goals

**Goals:**
- One place decides the claude instructions file name; every consumer reads the decision rather than the static `TARGETS.claude` constant or a literal.
- Never overwrite a hand-authored `@AGENTS.md` shim.
- Deterministic and explainable: the resolved name is printed by doc-init and stored in `.aspens.json`.
- Existing repos with a real `CLAUDE.md` see no behavior change.

**Non-Goals:**
- Changing the default for fresh repos (neither file present) away from `CLAUDE.md`.
- Migrating existing `CLAUDE.md` content into `AGENTS.md`.
- Any change to codex/opencode `AGENTS.md` handling or `ensureAspensManagedBlock`.
- Supporting arbitrary file names; only `CLAUDE.md` and `AGENTS.md` are accepted.

## Decisions

- **Resolve to a derived target object, not a mutated constant.** `resolveClaudeTarget(repoPath, { instructionsFile })` returns `{ ...TARGETS.claude, instructionsFile }`. Callers that already receive a target object (`transformForTarget`, `summarizeTarget`, `repairDeterministicSections`) need no signature change. Mutating `TARGETS.claude` would leak across tests and across multi-target runs.
- **Detection order:** explicit `--instructions-file` > `instructionsFile` in `.aspens.json` > on-disk detection > `CLAUDE.md`. Config wins over detection so `doc sync` stays stable after the user edits the shim or deletes a file mid-project; `doc init` re-runs detection only when no config value exists or the flag is passed.
- **Shim definition:** `CLAUDE.md` whose non-blank, non-HTML-comment lines are exactly one line matching `@AGENTS.md` or `@./AGENTS.md`. Anything else is a real `CLAUDE.md`. This is deliberately narrow; a `CLAUDE.md` with extra content is the user's overlay and stays the target.
- **Persist `instructionsFile` in `.aspens.json`** as an optional string validated against the two allowed names. `writeConfig` preserves it like `saveTokens`; `readConfig` rejects invalid values so a corrupted config falls back to inference.
- **`inferConfig` change:** `AGENTS.md` + `.claude/` (no `.codex/`, no `.agents/skills`) is already counted as claude via `hasClaudeArtifacts`; the resolver additionally records `AGENTS.md` as the file name when that combination is inferred and no `CLAUDE.md` exists.
- **`getAllowedPaths` and `parseLLMOutput`** use the resolved name so an LLM emitting `<file path="AGENTS.md">` is accepted and `<file path="CLAUDE.md">` is rejected for an AGENTS.md repo (path sanitization stays strict).
- **Prompt variable:** `doc-init-claudemd.md` already receives `CANONICAL_VARS.instructionsFile`; the remaining literal `CLAUDE.md` strings in the prompt body and the retry messages become the variable.

## Risks / Trade-offs

- **Ambiguity with codex/opencode repos.** `AGENTS.md` without `CLAUDE.md` can also mean a codex repo. Mitigation: detection only fires for the claude target and only when the user selected (or config records) the claude target; the codex-artifact checks in `inferConfig` are unchanged.
- **Wide fan-out of `'CLAUDE.md'` literals.** Missing one site produces a split-brain (e.g. import block in `AGENTS.md`, freshness check on `CLAUDE.md`). Mitigation: a test that greps `src/` for the literal outside `target.js`, and per-command tests for each write/read site.
- **Recursive `@import` depth.** Claude Code caps import depth at 5 hops; `CLAUDE.md` → `AGENTS.md` → `.claude/aspens-index.md` is 2. A real-tool verification task confirms the index loads through the shim.
- **doc-sync hook stability.** The post-commit hook runs `doc sync` non-interactively; it must read the persisted name and never fall back to detection, otherwise a transient missing file could flip the target. Covered by the config-wins ordering.
