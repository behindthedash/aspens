/**
 * Generation backend abstraction — detects and manages LLM backends.
 *
 * Backend = what generates the content (claude CLI, codex CLI)
 * Target  = where the output goes (claude, codex, all)
 *
 * Default: backend matches target. Users can override with --backend.
 */

import { execSync } from 'child_process';

// ---------------------------------------------------------------------------
// Backend definitions
// ---------------------------------------------------------------------------

export const BACKENDS = {
  claude: {
    id: 'claude',
    label: 'Claude CLI',
    command: 'claude',
    detectArgs: '--version',
    installUrl: 'https://docs.anthropic.com/claude-code',
  },
  codex: {
    id: 'codex',
    label: 'Codex CLI',
    command: 'codex',
    detectArgs: '--version',
    installUrl: 'https://github.com/openai/codex',
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode CLI',
    command: 'opencode',
    detectArgs: '--version',
    installUrl: 'https://opencode.ai',
  },
};

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Check if a CLI command is available on the system.
 * @param {string} command
 * @param {string} args
 * @returns {boolean}
 */
function isCommandAvailable(command, args) {
  try {
    execSync(`${command} ${args}`, { stdio: 'pipe', timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect which backends are installed.
 * @returns {Record<string, boolean>}
 */
export function detectAvailableBackends() {
  const result = {};
  for (const [id, backend] of Object.entries(BACKENDS)) {
    result[id] = isCommandAvailable(backend.command, backend.detectArgs);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve which backend to use.
 *
 * Priority:
 * 1. Explicit --backend flag
 * 2. Match target (claude target → claude backend, codex target → codex backend)
 * 3. Whatever is available
 *
 * @param {object} options
 * @param {string} [options.backendFlag] — explicit --backend value
 * @param {string} [options.targetId] — the chosen target id
 * @param {{ claude: boolean, codex: boolean }} options.available — detection result
 * @returns {{ backend: object, warning: string|null }}
 */
export function resolveBackend({ backendFlag, targetId, available }) {
  // Explicit flag wins
  if (backendFlag) {
    const backend = BACKENDS[backendFlag];
    if (!backend) {
      throw new Error(`Unknown backend: "${backendFlag}". Valid backends: ${Object.keys(BACKENDS).join(', ')}`);
    }
    if (!available[backendFlag]) {
      throw new Error(
        `${backend.label} is not installed. Install it: ${backend.installUrl}`
      );
    }
    return { backend, warning: null };
  }

  // Match target
  if (targetId && targetId !== 'all') {
    const matchingBackend = BACKENDS[targetId];
    if (matchingBackend && available[targetId]) {
      return { backend: matchingBackend, warning: null };
    }

    // Matching backend not available — fall back to the best available
    const fallbackId = Object.keys(BACKENDS).find(id => id !== targetId && available[id]);
    if (fallbackId) {
      const fallback = BACKENDS[fallbackId];
      const missing = BACKENDS[targetId];
      return {
        backend: fallback,
        warning: `${missing.label} not found. Using ${fallback.label} to generate ${targetId} output. For best results, install ${missing.label}: ${missing.installUrl}`,
      };
    }
  }

  // No target preference or target is 'all' — use whatever is available (prefer claude, then codex, then opencode)
  if (available.claude) return { backend: BACKENDS.claude, warning: null };
  if (available.codex) return { backend: BACKENDS.codex, warning: null };
  if (available.opencode) return { backend: BACKENDS.opencode, warning: null };

  // None available
  const installLines = Object.values(BACKENDS)
    .map(b => `  Install ${b.label}: ${b.installUrl}`)
    .join('\n');
  throw new Error(
    'aspens requires Claude CLI, Codex CLI, or OpenCode CLI.\n' + installLines
  );
}
