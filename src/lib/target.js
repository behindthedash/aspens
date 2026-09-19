/**
 * Target abstraction layer — maps logical output locations to concrete paths per target.
 *
 * Backend = what generates the content (claude, codex, opencode)
 * Target  = where the output goes (claude, codex, opencode)
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Target definitions
// ---------------------------------------------------------------------------

export const TARGETS = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    placement: 'centralized',
    format: 'markdown',
    instructionsFile: 'CLAUDE.md',
    configDir: '.claude',
    skillsDir: '.claude/skills',
    skillFilename: 'skill.md',
    hooksDir: '.claude/hooks',
    settingsFile: '.claude/settings.json',
    graphPath: '.claude/graph.json',
    codeMapPath: '.claude/code-map.md',
    graphIndexPath: '.claude/graph-index.json',
    agentsDir: '.claude/agents',
    commandsDir: '.claude/commands',
    supportsHooks: true,
    supportsSettings: true,
    supportsGraph: true,
    supportsSkills: false,
    supportsMCP: false,
    needsActivationSection: true,
    needsCodeMapEmbed: false,
  },
  codex: {
    id: 'codex',
    label: 'Codex CLI',
    placement: 'directory-scoped',
    format: 'markdown',
    instructionsFile: 'AGENTS.md',
    configDir: '.codex',
    skillsDir: '.agents/skills',
    userSkillsDir: '~/.agents/skills',
    skillFilename: 'SKILL.md',
    directoryDocFile: 'AGENTS.md',
    hooksDir: null,
    settingsFile: '.codex/config.toml',
    graphPath: null,
    codeMapPath: null,
    graphIndexPath: null,
    agentsDir: null,
    commandsDir: null,
    supportsHooks: false,
    supportsSettings: false,
    supportsGraph: false,
    supportsSkills: true,
    supportsMCP: false,
    needsActivationSection: false,
    needsCodeMapEmbed: false,
    maxInstructionsBytes: 32768,
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode CLI',
    placement: 'centralized',
    format: 'markdown',
    instructionsFile: 'AGENTS.md',
    configDir: '.opencode',
    skillsDir: '.claude/skills',
    skillFilename: 'skill.md',
    hooksDir: null,
    settingsFile: null,
    graphPath: null,
    codeMapPath: null,
    graphIndexPath: null,
    agentsDir: null,
    commandsDir: null,
    supportsHooks: false,
    supportsSettings: false,
    supportsGraph: false,
    supportsSkills: false,
    supportsMCP: false,
    needsActivationSection: true,
    needsCodeMapEmbed: false,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a single target by id.
 * @param {string} id — 'claude' or 'codex'
 * @returns {object} target definition
 */
export function resolveTarget(id) {
  const target = TARGETS[id];
  if (!target) {
    throw new Error(`Unknown target: "${id}". Valid targets: ${Object.keys(TARGETS).join(', ')}`);
  }
  return target;
}

/**
 * Resolve target option to an array of targets.
 * @param {string} option — a target id: 'claude', 'codex', or 'opencode'
 * @returns {object[]} array of target definitions
 */
export function resolveTargets(option) {
  return [resolveTarget(option)];
}

/**
 * Build the allowed paths config for parseFileOutput's sanitizePath,
 * as a union across all active targets.
 * @param {object[]} targets — array of target definitions
 * @returns {{ dirPrefixes: string[], exactFiles: string[] }}
 */
export function getAllowedPaths(targets) {
  const dirPrefixes = new Set();
  const exactFiles = new Set();

  for (const t of targets) {
    if (t.configDir) dirPrefixes.add(t.configDir + '/');
    if (t.skillsDir) dirPrefixes.add(t.skillsDir + '/');
    if (t.hooksDir) dirPrefixes.add(t.hooksDir + '/');
    if (t.agentsDir) dirPrefixes.add(t.agentsDir + '/');
    if (t.commandsDir) dirPrefixes.add(t.commandsDir + '/');
    exactFiles.add(t.instructionsFile);
  }

  return {
    dirPrefixes: [...dirPrefixes],
    exactFiles: [...exactFiles],
  };
}

export function mergeConfiguredTargets(existingTargets = [], nextTargets = []) {
  const validIds = new Set(Object.keys(TARGETS));
  const merged = [];

  for (const target of existingTargets) {
    if (validIds.has(target) && !merged.includes(target)) {
      merged.push(target);
    }
  }

  for (const target of nextTargets) {
    if (validIds.has(target) && !merged.includes(target)) {
      merged.push(target);
    }
  }

  return merged;
}

/**
 * Shorthand — returns path info for a target.
 * @param {string} targetId
 * @returns {object} target definition
 */
export function paths(targetId) {
  return resolveTarget(targetId);
}

// ---------------------------------------------------------------------------
// Claude instructions file resolution — CLAUDE.md vs AGENTS.md per repo
// ---------------------------------------------------------------------------

/**
 * Root instructions file names the claude target may use. `CLAUDE.md` is the
 * historical default; `AGENTS.md` is used by repos that keep a one-line
 * `@AGENTS.md` shim in CLAUDE.md (or no CLAUDE.md at all) and put the real
 * content in AGENTS.md.
 */
export const CLAUDE_INSTRUCTIONS_FILES = ['CLAUDE.md', 'AGENTS.md'];

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const AGENTS_SHIM_IMPORT_RE = /^@(?:\.\/)?AGENTS\.md$/;

/**
 * True when a CLAUDE.md body is a pure `@AGENTS.md` shim: after dropping HTML
 * comments and blank lines, exactly one line remains and it is `@AGENTS.md`
 * or `@./AGENTS.md`. Any other content (headings, prose, a second import)
 * means CLAUDE.md carries its own instructions and is NOT a shim.
 * @param {string} content
 * @returns {boolean}
 */
export function isAgentsMdShim(content) {
  if (typeof content !== 'string') return false;
  const lines = content
    .replace(/^\uFEFF/, '')
    .replace(HTML_COMMENT_RE, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  return lines.length === 1 && AGENTS_SHIM_IMPORT_RE.test(lines[0]);
}

/**
 * Detect which root instructions file the claude target should use in a repo
 * by inspecting the files on disk (no `.aspens.json` involvement):
 *   - CLAUDE.md present and NOT a shim        → 'CLAUDE.md'
 *   - CLAUDE.md present and IS an `@AGENTS.md` shim → 'AGENTS.md'
 *   - no CLAUDE.md, AGENTS.md present         → 'AGENTS.md'
 *   - neither present                         → 'CLAUDE.md'
 * @param {string} repoPath
 * @returns {'CLAUDE.md'|'AGENTS.md'}
 */
export function detectClaudeInstructionsFile(repoPath) {
  const claudeMdPath = join(repoPath, 'CLAUDE.md');
  const agentsMdPath = join(repoPath, 'AGENTS.md');

  if (existsSync(claudeMdPath)) {
    let content = '';
    try {
      content = readFileSync(claudeMdPath, 'utf8');
    } catch {
      return 'CLAUDE.md';
    }
    return isAgentsMdShim(content) ? 'AGENTS.md' : 'CLAUDE.md';
  }

  if (existsSync(agentsMdPath)) return 'AGENTS.md';
  return 'CLAUDE.md';
}

function isValidClaudeInstructionsFile(value) {
  return typeof value === 'string' && CLAUDE_INSTRUCTIONS_FILES.includes(value);
}

/**
 * Resolve the claude target for a specific repo, with `instructionsFile`
 * chosen by precedence: explicit override > `.aspens.json` `instructionsFile`
 * > on-disk detection > 'CLAUDE.md'. Returns a fresh object; `TARGETS.claude`
 * is never mutated.
 * @param {string} repoPath
 * @param {{ instructionsFile?: string }} [options]
 * @returns {object} claude target definition with the resolved `instructionsFile`
 */
export function resolveClaudeTarget(repoPath, { instructionsFile } = {}) {
  let resolved;

  if (instructionsFile !== undefined && instructionsFile !== null) {
    if (!isValidClaudeInstructionsFile(instructionsFile)) {
      throw new Error(
        `Invalid instructions file: "${instructionsFile}". Valid values: ${CLAUDE_INSTRUCTIONS_FILES.join(', ')}`
      );
    }
    resolved = instructionsFile;
  } else {
    const config = readConfig(repoPath);
    if (config && isValidClaudeInstructionsFile(config.instructionsFile)) {
      resolved = config.instructionsFile;
    } else {
      resolved = detectClaudeInstructionsFile(repoPath);
    }
  }

  return { ...TARGETS.claude, instructionsFile: resolved };
}

// ---------------------------------------------------------------------------
// Config persistence — .aspens.json at repo root
// ---------------------------------------------------------------------------

const CONFIG_FILE = '.aspens.json';

/**
 * Read persisted aspens config from .aspens.json.
 * @param {string} repoPath
 * @returns {{ targets: string[], backend: string|null, version: string } | null}
 */
export function readConfig(repoPath) {
  const configPath = join(repoPath, CONFIG_FILE);
  if (!existsSync(configPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
    return isValidConfig(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isValidSaveTokensConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  const {
    enabled,
    warnAtTokens,
    compactAtTokens,
    saveHandoff,
    sessionRotation,
    claude,
    codex,
  } = config;

  if (typeof enabled !== 'boolean') return false;
  if (!Number.isInteger(warnAtTokens) || warnAtTokens <= 0) return false;
  if (!Number.isInteger(compactAtTokens) || compactAtTokens <= 0) return false;
  // Allow either threshold to be MAX_SAFE_INTEGER (disabled sentinel)
  if (warnAtTokens !== Number.MAX_SAFE_INTEGER && compactAtTokens !== Number.MAX_SAFE_INTEGER && compactAtTokens <= warnAtTokens) return false;
  if (typeof saveHandoff !== 'boolean') return false;
  if (typeof sessionRotation !== 'boolean') return false;
  if (claude !== undefined) {
    if (!claude || typeof claude !== 'object' || Array.isArray(claude)) return false;
    if (claude.enabled !== undefined && typeof claude.enabled !== 'boolean') return false;
    if (claude.mode !== undefined && !['automatic', 'manual'].includes(claude.mode)) return false;
  }
  if (codex !== undefined) {
    if (!codex || typeof codex !== 'object' || Array.isArray(codex)) return false;
    if (codex.enabled !== undefined && typeof codex.enabled !== 'boolean') return false;
    if (codex.mode !== undefined && !['automatic', 'manual'].includes(codex.mode)) return false;
  }

  return true;
}

function isValidConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;

  const { targets, backend, version, saveTokens, instructionsFile } = config;

  if (!Array.isArray(targets) || targets.length === 0) return false;
  if (!targets.every(target => typeof target === 'string' && Object.prototype.hasOwnProperty.call(TARGETS, target))) {
    return false;
  }
  if (backend !== null && backend !== undefined && (typeof backend !== 'string' || !Object.prototype.hasOwnProperty.call(TARGETS, backend))) {
    return false;
  }
  if (version !== undefined && typeof version !== 'string') return false;
  if (saveTokens !== undefined && !isValidSaveTokensConfig(saveTokens)) return false;
  if (instructionsFile !== undefined && !isValidClaudeInstructionsFile(instructionsFile)) return false;

  return true;
}

/**
 * Write aspens config to .aspens.json.
 * @param {string} repoPath
 * @param {object} config — { targets: string[], backend?: string, instructionsFile?: 'CLAUDE.md'|'AGENTS.md' }
 */
export function writeConfig(repoPath, config) {
  const configPath = join(repoPath, CONFIG_FILE);
  const existing = readConfig(repoPath);
  const data = {
    targets: config.targets || existing?.targets,
    backend: config.backend ?? existing?.backend ?? null,
    version: '1.0',
  };
  // Preserve feature config by default. Commands that intentionally remove
  // save-tokens must pass saveTokens: null.
  const saveTokens = config.saveTokens === undefined ? existing?.saveTokens : config.saveTokens;
  if (saveTokens !== undefined && saveTokens !== null) {
    data.saveTokens = saveTokens;
  }
  // Preserve the recorded claude instructions file unless the caller passes a
  // new value; pass instructionsFile: null to explicitly drop it.
  const instructionsFile = config.instructionsFile === undefined
    ? existing?.instructionsFile
    : config.instructionsFile;
  if (instructionsFile !== undefined && instructionsFile !== null) {
    if (!isValidClaudeInstructionsFile(instructionsFile)) {
      throw new Error(
        `Invalid instructions file: "${instructionsFile}". Valid values: ${CLAUDE_INSTRUCTIONS_FILES.join(', ')}`
      );
    }
    data.instructionsFile = instructionsFile;
  }
  writeFileSync(configPath, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Infer target config from generated repo artifacts when .aspens.json is missing.
 * @param {string} repoPath
 * @returns {{ targets: string[], backend: string|null, version: string, instructionsFile?: 'AGENTS.md' } | null}
 */
export function inferConfig(repoPath) {
  const hasClaudeMd = existsSync(join(repoPath, TARGETS.claude.instructionsFile || 'CLAUDE.md'));
  const hasClaudeArtifacts =
    existsSync(join(repoPath, TARGETS.claude.configDir || '.claude')) ||
    existsSync(join(repoPath, TARGETS.claude.skillsDir || '.claude/skills')) ||
    hasClaudeMd;

  const hasCodexConfig = existsSync(join(repoPath, TARGETS.codex.configDir || '.codex'));
  const hasCodexSkills = existsSync(join(repoPath, TARGETS.codex.skillsDir || '.agents/skills'));
  const hasCodexInstructions = existsSync(join(repoPath, TARGETS.codex.instructionsFile || 'AGENTS.md'));
  const hasCodexArtifacts =
    hasCodexConfig ||
    hasCodexSkills ||
    (hasCodexInstructions && (hasCodexConfig || hasCodexSkills));

  // OpenCode shares codex's instructionsFile (AGENTS.md) and claude's
  // skillsDir (.claude/skills), so it only counts as present when AGENTS.md
  // exists WITHOUT any codex-specific artifact (.codex/ or .agents/skills) —
  // otherwise an AGENTS.md + .claude/skills repo is ambiguous with a
  // Claude-only repo and is left to hasClaudeArtifacts instead.
  const hasOpenCodeArtifacts =
    hasClaudeArtifacts &&
    hasCodexInstructions &&
    !hasCodexConfig &&
    !hasCodexSkills;

  const targets = [];
  if (hasClaudeArtifacts) targets.push('claude');
  if (hasCodexArtifacts) targets.push('codex');
  if (hasOpenCodeArtifacts) targets.push('opencode');

  if (targets.length === 0) return null;

  const inferred = {
    targets,
    backend: null,
    version: '1.0',
  };

  // A claude repo whose root instructions live in AGENTS.md (no CLAUDE.md, or
  // only an `@AGENTS.md` shim) must record that so later runs don't fall back
  // to creating/clobbering CLAUDE.md. CLAUDE.md stays the implicit default.
  if (hasClaudeArtifacts && detectClaudeInstructionsFile(repoPath) === 'AGENTS.md') {
    inferred.instructionsFile = 'AGENTS.md';
  }

  return inferred;
}

/**
 * Read .aspens.json, or recover it from repo artifacts if it was deleted.
 * Side effect: if readConfig() returns null and inferConfig() succeeds, this
 * will persist the inferred config via writeConfig() unless options.persist is false.
 * @param {string} repoPath
 * @param {{ persist?: boolean }} [options]
 * @returns {{ config: { targets: string[], backend: string|null, version: string } | null, recovered: boolean }}
 */
export function loadConfig(repoPath, options = {}) {
  const config = readConfig(repoPath);
  if (config) {
    return { config, recovered: false };
  }

  const inferred = inferConfig(repoPath);
  if (!inferred) {
    return { config: null, recovered: false };
  }

  if (options.persist !== false) {
    writeConfig(repoPath, inferred);
  }

  return { config: inferred, recovered: true };
}
