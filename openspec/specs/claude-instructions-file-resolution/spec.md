# claude-instructions-file-resolution Specification

## Purpose
Defines how the claude target chooses between `CLAUDE.md` and `AGENTS.md` as its root instructions file, so aspens writes into the file the repo actually uses for Claude Code instructions instead of always creating `CLAUDE.md`.
## Requirements
### Requirement: Claude target instructions file is resolved per repo
The system SHALL expose a resolver for the claude target that returns a target object identical to `TARGETS.claude` except for `instructionsFile`, which SHALL be either `CLAUDE.md` or `AGENTS.md`. The resolver SHALL apply sources in this precedence: explicit override, `instructionsFile` persisted in `.aspens.json`, on-disk detection, then the default `CLAUDE.md`. The static `TARGETS.claude` constant SHALL NOT be mutated.

#### Scenario: Fresh repo with neither file
- **WHEN** the repo has no `CLAUDE.md` and no `AGENTS.md`, no `.aspens.json` value, and no override
- **THEN** the resolver returns `instructionsFile: 'CLAUDE.md'`

#### Scenario: AGENTS.md present without CLAUDE.md
- **WHEN** the repo has `AGENTS.md` and no `CLAUDE.md`, and no `.aspens.json` value or override
- **THEN** the resolver returns `instructionsFile: 'AGENTS.md'`

#### Scenario: CLAUDE.md is an @AGENTS.md shim
- **WHEN** `CLAUDE.md` exists and its only non-blank, non-HTML-comment line is `@AGENTS.md` or `@./AGENTS.md`
- **THEN** the resolver returns `instructionsFile: 'AGENTS.md'`

#### Scenario: CLAUDE.md has real content
- **WHEN** `CLAUDE.md` exists and contains any line other than blank lines, HTML comments, and the `@AGENTS.md` import (for example a heading, or `@AGENTS.md` plus a `## Conventions` section)
- **THEN** the resolver returns `instructionsFile: 'CLAUDE.md'` even if `AGENTS.md` also exists

#### Scenario: Persisted config wins over detection
- **WHEN** `.aspens.json` contains `"instructionsFile": "AGENTS.md"` and the repo currently has a real `CLAUDE.md` (or neither file)
- **THEN** the resolver returns `instructionsFile: 'AGENTS.md'` without inspecting the files

#### Scenario: Explicit override wins over config
- **WHEN** an override of `CLAUDE.md` is supplied and `.aspens.json` contains `"instructionsFile": "AGENTS.md"`
- **THEN** the resolver returns `instructionsFile: 'CLAUDE.md'`

#### Scenario: Invalid override is rejected
- **WHEN** an override other than `CLAUDE.md` or `AGENTS.md` is supplied (for example `docs/INSTRUCTIONS.md`)
- **THEN** the resolver throws an error naming the two accepted values

### Requirement: `aspens doc init` accepts `--instructions-file`
`aspens doc init` SHALL accept `--instructions-file <name>` with values `CLAUDE.md` or `AGENTS.md`. The option SHALL only affect the claude target; passing it with `--target codex` or `--target opencode` SHALL fail with a `CliError` explaining that those targets always use `AGENTS.md`.

#### Scenario: Override forces AGENTS.md on a fresh repo
- **WHEN** the user runs `aspens doc init --target claude --instructions-file AGENTS.md` in a repo with neither instructions file
- **THEN** the root instructions file is generated as `AGENTS.md` and no `CLAUDE.md` is created

#### Scenario: Invalid value fails fast
- **WHEN** the user runs `aspens doc init --instructions-file INSTRUCTIONS.md`
- **THEN** the command exits with a `CliError` before any LLM call or file write

#### Scenario: Option rejected for non-claude target
- **WHEN** the user runs `aspens doc init --target codex --instructions-file CLAUDE.md`
- **THEN** the command exits with a `CliError` before any LLM call or file write

### Requirement: Resolved instructions file is persisted in `.aspens.json`
`writeConfig` SHALL accept an optional `instructionsFile` and persist it; `readConfig` SHALL accept `instructionsFile` when it is `CLAUDE.md` or `AGENTS.md` and SHALL treat the whole config as invalid otherwise. A `.aspens.json` without `instructionsFile` SHALL remain valid and mean "resolve at runtime".

#### Scenario: doc init records the resolved name
- **WHEN** `aspens doc init --target claude` resolves `AGENTS.md` (by detection or override) and completes
- **THEN** `.aspens.json` contains `"instructionsFile": "AGENTS.md"` alongside `targets`, `backend`, and `version`

#### Scenario: Existing config without the field stays valid
- **WHEN** `.aspens.json` is `{ "targets": ["claude"], "backend": null, "version": "1.0" }`
- **THEN** `readConfig` returns it unchanged and the resolver falls through to on-disk detection

#### Scenario: writeConfig preserves the field across unrelated writes
- **WHEN** `.aspens.json` already has `"instructionsFile": "AGENTS.md"` and `writeConfig` is called with only `{ saveTokens: ... }`
- **THEN** the written file still contains `"instructionsFile": "AGENTS.md"`

#### Scenario: Corrupt value falls back to inference
- **WHEN** `.aspens.json` has `"instructionsFile": "README.md"`
- **THEN** `readConfig` returns `null` and `loadConfig` proceeds via `inferConfig`

### Requirement: Config inference records AGENTS.md for AGENTS.md-only claude repos
When `.aspens.json` is missing and `inferConfig` classifies the repo as claude because `.claude/` or `.claude/skills` exists alongside `AGENTS.md` with no `CLAUDE.md`, the inferred config SHALL include `instructionsFile: 'AGENTS.md'`.

#### Scenario: Recovered config after deleting .aspens.json
- **WHEN** a repo has `.claude/skills/base/skill.md`, `AGENTS.md`, no `CLAUDE.md`, no `.codex/`, no `.agents/skills`, and no `.aspens.json`
- **THEN** `loadConfig` persists a config with `targets: ['claude']` and `instructionsFile: 'AGENTS.md'`

#### Scenario: CLAUDE.md present keeps the default
- **WHEN** a repo has `.claude/skills/base/skill.md` and a real `CLAUDE.md`, and no `.aspens.json`
- **THEN** the inferred config has no `instructionsFile` field (runtime resolution yields `CLAUDE.md`)

