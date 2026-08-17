import { execSync, spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join, dirname, normalize, resolve, relative, sep } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, '..', 'prompts');
const PARTIALS_DIR = join(PROMPTS_DIR, 'partials');
let codexExecCapabilities = null;

// Default paths that parseFileOutput is allowed to write to
const DEFAULT_ALLOWED_DIR_PREFIXES = ['.claude/'];
const DEFAULT_ALLOWED_EXACT_FILES = ['CLAUDE.md'];

/**
 * Check if claude CLI is available.
 */
function checkClaude() {
  try {
    execSync(process.platform === 'win32' ? 'where claude' : 'which claude', { stdio: 'pipe', timeout: 5000 });
  } catch {
    throw new Error(
      'Claude Code CLI not found. Install it first:\n' +
      '  npm install -g @anthropic-ai/claude-code\n\n' +
      'Or use --runner api (coming soon) to use the API directly.'
    );
  }
}

function getCodexExecCapabilities() {
  if (codexExecCapabilities) return codexExecCapabilities;

  try {
    const help = execSync('codex exec --help', {
      stdio: 'pipe',
      timeout: 5000,
      encoding: 'utf8',
    });

    codexExecCapabilities = {
      supportsAskForApproval: help.includes('--ask-for-approval'),
    };
  } catch {
    codexExecCapabilities = {
      supportsAskForApproval: false,
    };
  }

  return codexExecCapabilities;
}

/**
 * Execute a prompt via Claude Code CLI (claude -p).
 * Always uses stream-json for token tracking.
 * Returns { text, usage } where usage has output_tokens, tool_uses, tool_result_chars.
 */
export function runClaude(prompt, options = {}) {
  const { timeout = 300000, allowedTools = null, disableTools = false, verbose = false, onActivity = null, model = null } = options;

  checkClaude();

  let toolFlags = [];
  if (disableTools) {
    toolFlags = ['--disallowedTools', 'Bash,Read,Write,Edit,Glob,Grep,Agent,WebSearch,WebFetch,NotebookEdit'];
  } else if (allowedTools && allowedTools.length > 0) {
    // `--allowedTools` only pre-approves tools for the interactive permission
    // prompt — in non-interactive `-p` mode there's no prompt to skip, so it
    // has no restrictive effect and the CLI's full default tool set (Write,
    // Edit, Bash, MCP servers, ...) stays available regardless. `--tools`
    // is the flag that actually defines the available tool set; confirmed via
    // a live probe (`claude -p --allowedTools Read,Glob,Grep` still wrote a
    // file; `claude -p --tools Read,Glob,Grep` correctly refused). Using
    // `--allowedTools` here let the read-only-restricted generation calls
    // write files directly via their own Write tool, bypassing aspens' own
    // target-filtering entirely (e.g. a canonical CLAUDE.md/.claude/skills/*
    // file landing on disk even on a --target codex run).
    toolFlags = ['--tools', allowedTools.join(',')];
  }

  const modelFlags = model ? ['--model', model] : [];

  // Always use stream-json so we can extract token usage
  // Claude CLI requires --verbose when using stream-json with -p
  const args = ['-p', '--verbose', ...toolFlags, ...modelFlags, '--output-format', 'stream-json'];

  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    const chunks = [];
    const errChunks = [];
    let lineBuffer = '';

    child.stdout.on('data', (data) => {
      chunks.push(data);

      // Parse stream events for verbose activity display
      if (verbose && onActivity) {
        lineBuffer += data.toString('utf8');
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            handleStreamEvent(JSON.parse(line), onActivity);
          } catch { /* not JSON */ }
        }
      }
    });

    child.stderr.on('data', (data) => errChunks.push(data));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) {
        try { execSync(`taskkill /pid ${child.pid} /t /f`, { stdio: 'ignore' }); } catch { /* ignore */ }
      } else {
        child.kill('SIGTERM');
      }
    }, timeout);

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks).toString('utf8');
      const stderr = Buffer.concat(errChunks).toString('utf8');

      if (timedOut || signal === 'SIGTERM' || signal === 'SIGKILL') {
        reject(new Error(`Claude timed out after ${timeout / 1000}s. Try a smaller repo or increase --timeout.`));
      } else if (code === 0) {
        const { text, usage } = extractResultFromStream(stdout);
        resolve({ text, usage });
      } else if (stderr.includes('rate limit')) {
        reject(new Error('Claude rate limit hit. Wait a moment and try again.'));
      } else {
        reject(new Error(`Claude exited with code ${code}${stderr ? ': ' + stderr.slice(0, 500) : ''}`));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Claude failed to start: ${err.message}`));
    });

    // Write prompt to stdin with backpressure handling
    const ok = child.stdin.write(prompt);
    if (!ok) {
      child.stdin.once('drain', () => child.stdin.end());
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Route a prompt to the selected backend while preserving the shared options shape.
 * Returns the same { text, usage } contract as runClaude/runCodex.
 */
export function runLLM(prompt, options = {}, backendId = 'claude') {
  if (backendId === 'codex') {
    return runCodex(prompt, {
      timeout: options.timeout,
      verbose: options.verbose,
      onActivity: options.onActivity,
      model: options.model,
      cwd: options.cwd,
    });
  }
  if (backendId === 'opencode') {
    return runOpenCode(prompt, {
      timeout: options.timeout,
      verbose: options.verbose,
      onActivity: options.onActivity,
      model: options.model,
      cwd: options.cwd,
    });
  }
  return runClaude(prompt, options);
}

/**
 * Execute a prompt via Codex CLI (codex exec).
 * Uses --json for JSONL event streaming.
 * Returns { text, usage } matching runClaude's interface.
 */
export function runCodex(prompt, options = {}) {
  const { timeout = 300000, verbose = false, onActivity = null, model = null, cwd = null } = options;
  const capabilities = getCodexExecCapabilities();

  const args = [
    'exec',
    '--json',
    '--sandbox',
    'read-only',
    '--ephemeral',
  ];
  if (capabilities.supportsAskForApproval) {
    args.push('--ask-for-approval', 'never');
  }
  if (model) args.push('--model', model);
  if (cwd) args.push('--cd', cwd);
  // Pass prompt via stdin (using '-' placeholder) to avoid shell arg length limits
  args.push('-');

  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    const chunks = [];
    const errChunks = [];
    let lineBuffer = '';

    child.stdout.on('data', (data) => {
      chunks.push(data);

      if (verbose && onActivity) {
        lineBuffer += data.toString('utf8');
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            const itemType = normalizeCodexItemType(event.item?.type || event.item?.details?.type);
            if ((event.type === 'item.updated' || event.type === 'item.completed') && itemType === 'agent_message') {
              onActivity('Codex generating...');
            } else if (event.type === 'item.completed' && itemType === 'command_execution') {
              const command = event.item?.command || event.item?.details?.command;
              onActivity(`Codex ran: ${command?.slice(0, 60) || 'command'}`);
            }
          } catch { /* not JSON */ }
        }
      }
    });

    child.stderr.on('data', (data) => errChunks.push(data));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) {
        try { execSync(`taskkill /pid ${child.pid} /t /f`, { stdio: 'ignore' }); } catch { /* ignore */ }
      } else {
        child.kill('SIGTERM');
      }
    }, timeout);

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks).toString('utf8');
      const stderr = Buffer.concat(errChunks).toString('utf8');

      if (timedOut || signal === 'SIGTERM' || signal === 'SIGKILL') {
        reject(new Error(`Codex timed out after ${timeout / 1000}s. Try a smaller repo or increase --timeout.`));
      } else if (code === 0) {
        const { text, usage } = extractResultFromCodexStream(stdout);
        if (process.env.ASPENS_DEBUG) {
          console.error(`[debug] Codex exited 0, stdout ${stdout.length} bytes, parsed text ${text.length} chars`);
        }
        resolve({ text, usage });
      } else if (stderr.includes('rate limit') || stderr.includes('429')) {
        reject(new Error('Codex rate limit hit. Wait a moment and try again.'));
      } else {
        if (process.env.ASPENS_DEBUG) {
          console.error(`[debug] Codex exited ${code}, stderr: ${stderr.slice(0, 1000)}`);
          console.error(`[debug] Codex stdout (first 500): ${stdout.slice(0, 500)}`);
        }
        reject(new Error(`Codex exited with code ${code}${stderr ? ': ' + stderr.slice(0, 500) : ''}`));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Codex failed to start: ${err.message}. Is Codex CLI installed?`));
    });

    // Write prompt to stdin after handlers are attached so fast failures are captured.
    const ok = child.stdin.write(prompt);
    if (!ok) {
      child.stdin.once('drain', () => child.stdin.end());
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Execute a prompt via OpenCode CLI (opencode run).
 * Uses --format json for structured event output.
 * Returns { text, usage } matching runClaude's interface.
 */
export function runOpenCode(prompt, options = {}) {
  const { timeout = 300000, verbose = false, onActivity = null, model = null, cwd = null } = options;

  // Write prompt to temp file for long prompts
  const promptFile = join(tmpdir(), `aspens-opencode-prompt-${Date.now()}.md`);
  writeFileSync(promptFile, prompt, 'utf8');

  // model is spawned through a shell on Windows (see below) — reject
  // anything outside a safe model-id charset before it can reach argv.
  if (model && !/^[A-Za-z0-9_.\-/:]+$/.test(model)) {
    throw new Error(`Invalid --model value for OpenCode: ${model}`);
  }

  // The message must precede `-f` — `-f`/`--file` is a yargs array-type
  // option, so a bare positional placed after it gets swallowed into the
  // file array instead of being treated as the message.
  const args = [
    'run',
    'Generate repo documentation based on the attached prompt file',
    '--format', 'json',
    '-f', promptFile,
  ];
  if (model) args.push('--model', model);
  // Resolve to an absolute path: runOpenCode is exported and may receive a
  // relative cwd, and on Windows this value is spawned through a shell.
  if (cwd) args.push('--dir', resolve(cwd));

  const cleanupPromptFile = () => {
    try { rmSync(promptFile, { force: true }); } catch { /* ignore */ }
  };

  return new Promise((resolve, reject) => {
    // Unlike runClaude/runCodex, the prompt is passed via -f (a file), not
    // stdin — an open, never-written, never-closed stdin pipe makes
    // `opencode run` hang indefinitely before it even starts (confirmed:
    // `sleep 999 | opencode run ...` never gets past its init phase).
    // 'ignore' means no stdin pipe exists at all.
    const child = spawn('opencode', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    const chunks = [];
    const errChunks = [];
    // Keyed by part.id: a "text" event carries the full accumulated text
    // for that part (not a delta), and later events for the same id replace
    // earlier ones. Distinct part ids are separate text blocks, joined in
    // first-seen order.
    const textPartsById = new Map();
    let usage = { output_tokens: 0, tool_uses: 0, tool_result_chars: 0 };
    let lineBuffer = '';
    // Latches true on the first non-empty text part — a part's text only
    // grows across streamed updates for the same id, never shrinks back to
    // empty, so once this is true `combined` at close time is guaranteed
    // non-empty and the raw-output fallback can never fire.
    let hasRealText = false;

    function processOpenCodeLine(line) {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        const part = event.part;
        if (event.type === 'text' && part?.type === 'text' && typeof part.text === 'string') {
          textPartsById.set(part.id, part.text);
          if (part.text.length > 0) hasRealText = true;
        }
        if ((event.type === 'step_finish' || event.type === 'step-finish') && part?.tokens) {
          usage.output_tokens = part.tokens.output || 0;
        }
        if (event.type === 'tool' || part?.type === 'tool') {
          usage.tool_uses++;
        }
        if (verbose && onActivity) {
          if (event.type === 'step_start') {
            onActivity('OpenCode thinking...');
          }
        }
      } catch { /* not JSON */ }
    }

    child.stdout.on('data', (data) => {
      // `chunks` only feeds the raw-output fallback below, which triggers
      // when combined text ends up empty. Once real (non-empty) text has
      // been seen, the fallback can't fire, so stop duplicating the buffer.
      if (!hasRealText) {
        chunks.push(data);
      }
      // Parse JSON events for text content — buffer across chunks since a
      // record can span multiple `data` callbacks.
      lineBuffer += data.toString('utf8');
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop();
      for (const line of lines) processOpenCodeLine(line);
    });

    child.stderr.on('data', (data) => errChunks.push(data));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) {
        try { execSync(`taskkill /pid ${child.pid} /t /f`, { stdio: 'ignore' }); } catch { /* ignore */ }
      } else {
        child.kill('SIGTERM');
      }
    }, timeout);

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (lineBuffer.trim()) processOpenCodeLine(lineBuffer);
      cleanupPromptFile();

      if (timedOut || signal === 'SIGTERM' || signal === 'SIGKILL') {
        reject(new Error(`OpenCode timed out after ${timeout / 1000}s. Try a smaller repo or increase --timeout.`));
      } else if (code === 0) {
        const combined = [...textPartsById.values()].join('\n').trim();
        if (!combined && chunks.length > 0) {
          // Fallback: try to extract from raw output
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({ text: raw, usage });
        } else {
          resolve({ text: combined, usage });
        }
      } else if (code === 127) {
        reject(new Error('OpenCode CLI not found. Install it first: https://opencode.ai'));
      } else {
        const stderr = Buffer.concat(errChunks).toString('utf8');
        if (stderr.includes('rate limit') || stderr.includes('429')) {
          reject(new Error('OpenCode rate limit hit. Wait a moment and try again.'));
        } else {
          reject(new Error(`OpenCode exited with code ${code}${stderr ? ': ' + stderr.slice(0, 500) : ''}`));
        }
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      cleanupPromptFile();
      reject(new Error(`OpenCode failed to start: ${err.message}. Is OpenCode CLI installed?`));
    });
  });
}

/**
 * Extract final text and usage from Codex JSONL stream output.
 * Codex events: thread.started, item.started, item.updated, item.completed, turn.completed
 */
function extractResultFromCodexStream(rawOutput) {
  const lines = rawOutput.split('\n').filter(l => l.trim());
  const textParts = [];
  let usage = { output_tokens: 0, tool_uses: 0, tool_result_chars: 0 };

  if (process.env.ASPENS_DEBUG) {
    try { writeFileSync(join(tmpdir(), 'aspens-debug-codex-stream.json'), rawOutput); } catch {}
  }

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      const itemType = normalizeCodexItemType(event.item?.type || event.item?.details?.type);

      // Collect agent message text from completed items
      if (event.type === 'item.completed' && itemType === 'agent_message') {
        const content = event.item?.text ?? event.item?.content ?? event.item?.details?.content;
        collectCodexText(content, textParts);
      }

      // Count tool uses (command executions, file changes)
      if (event.type === 'item.completed') {
        if (itemType === 'command_execution' || itemType === 'file_change' || itemType === 'mcp_tool_call') {
          usage.tool_uses++;
        }
      }

      // Extract usage from turn.completed
      if (event.type === 'turn.completed' && event.usage) {
        usage.output_tokens = event.usage.output_tokens || event.usage.outputTokens || 0;
      }
    } catch { /* not JSON — skip */ }
  }

  return { text: textParts.join('\n'), usage };
}

function normalizeCodexItemType(type) {
  if (!type || typeof type !== 'string') return '';
  return type
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase();
}

function collectCodexText(content, parts) {
  if (!content) return;

  if (typeof content === 'string') {
    parts.push(content);
    return;
  }

  if (Array.isArray(content)) {
    for (const block of content) {
      collectCodexText(block, parts);
    }
    return;
  }

  if (typeof content === 'object') {
    if (typeof content.text === 'string') {
      parts.push(content.text);
      return;
    }
    if (typeof content.content === 'string') {
      parts.push(content.content);
      return;
    }
  }
}

/**
 * Load a prompt template from src/prompts/ and substitute variables.
 */
export function loadPrompt(name, vars = {}) {
  const promptPath = join(PROMPTS_DIR, `${name}.md`);
  let content = readFileSync(promptPath, 'utf8');

  // Resolve partials: {{partial-name}} → contents of partials/partial-name.md
  content = content.replace(/\{\{([a-z0-9-]+)\}\}/g, (match, partialName) => {
    const partialPath = join(PARTIALS_DIR, `${partialName}.md`);
    if (existsSync(partialPath)) {
      return readFileSync(partialPath, 'utf8');
    }
    return match;
  });

  // Warn about unresolved partials (not files, not variables)
  const remaining = content.match(/\{\{([a-z0-9-]+)\}\}/g) || [];
  const varKeys = new Set(Object.keys(vars));
  for (const token of remaining) {
    const partialName = token.slice(2, -2);
    if (!varKeys.has(partialName)) {
      console.error(`Warning: unresolved partial {{${partialName}}} in prompt ${name}.md`);
    }
  }

  // Resolve variables: {{varName}} → vars[varName]
  for (const [key, value] of Object.entries(vars)) {
    const replacement = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    content = content.replaceAll(`{{${key}}}`, replacement);
  }

  return content;
}

/**
 * Parse Claude's output into discrete files.
 * Primary format: <file path="...">content</file> (XML tags)
 * Fallback: <!-- file: path --> markers (legacy)
 * Validates paths to prevent traversal.
 */
/**
 * @param {string} output — raw LLM output
 * @param {{ dirPrefixes?: string[], exactFiles?: string[] }} [allowedPaths] — override allowed paths (default: .claude/ + CLAUDE.md)
 */
export function parseFileOutput(output, allowedPaths) {
  let files = [];

  // Primary: Split on <file path="..."> tags and match to next </file> outside code fences.
  // Strategy: find all </file> positions that are NOT inside ``` fenced code blocks,
  // then match each <file> open tag to the nearest valid </file>.
  const openTagPattern = /<file\s+path=["'](.+?)["']>/g;

  // Pre-compute which character positions are inside fenced code blocks
  const fenceRanges = [];
  const fenceRegex = /(^|\n)```[^\n]*\n([\s\S]*?)(?:\n```|$)/g;
  let fm;
  while ((fm = fenceRegex.exec(output)) !== null) {
    const start = fm.index + fm[1].length; // skip leading newline if present
    fenceRanges.push([start, fm.index + fm[0].length]);
  }
  function isInsideFence(pos) {
    for (const [start, end] of fenceRanges) {
      if (pos >= start && pos < end) return true;
    }
    return false;
  }

  // Find all valid </file> positions (at line start, outside code fences)
  const closePositions = [];
  const closeRegex = /(^|\n)<\/file>/g;
  let cm;
  while ((cm = closeRegex.exec(output)) !== null) {
    const tagStart = cm.index + cm[1].length;
    if (!isInsideFence(tagStart)) {
      closePositions.push(cm.index);
    }
  }

  let openMatch;
  while ((openMatch = openTagPattern.exec(output)) !== null) {
    if (isInsideFence(openMatch.index)) continue;
    const filePath = sanitizePath(openMatch[1].trim(), allowedPaths);
    if (!filePath) continue;

    const contentStart = openMatch.index + openMatch[0].length;

    // Find the first valid </file> AFTER this open tag
    const closePos = closePositions.find(p => p >= contentStart);

    let content;
    if (closePos !== undefined) {
      content = output.slice(contentStart, closePos).trim() + '\n';
      // Advance past this </file> tag
      openTagPattern.lastIndex = closePos + '\n</file>'.length;
    } else {
      // No valid closing tag — take up to next <file or end (don't eat next file)
      const remaining = output.slice(contentStart);
      const nextOpen = remaining.match(/<file\s+path=/);
      content = (nextOpen ? remaining.slice(0, nextOpen.index) : remaining).trim() + '\n';
    }

    files.push({ path: filePath, content });
  }

  // Fallback: HTML comment markers with content between them
  if (files.length === 0) {
    const commentPattern = /<!--\s*file:\s*(.+?)\s*-->\s*\n([\s\S]*?)(?=<!--\s*file:|<file\s|$)/g;
    let match;
    while ((match = commentPattern.exec(output)) !== null) {
      const filePath = sanitizePath(match[1].trim(), allowedPaths);
      const content = match[2].trim() + '\n';
      if (filePath && content.length > 10) {
        files.push({ path: filePath, content });
      }
    }
  }

  return files;
}

/**
 * Validate generated skill files for common issues.
 * Returns { valid: true } or { valid: false, issues: [...] }
 */
export function validateSkillFiles(files, repoPath) {
  const issues = [];

  for (const file of files) {
    const { path: filePath, content } = file;

    // Check for truncated content (likely XML parser collision)
    // Only flag <file path="..."> as a raw tag — ignore mentions inside backticks/code blocks
    const hasRawFileTag = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '').match(/<file\s+path=/);
    if (content.endsWith('<\n') || content.endsWith('`<\n') || hasRawFileTag) {
      issues.push({ file: filePath, issue: 'truncated', detail: 'Content appears truncated — likely XML tag collision' });
    }

    // Check skills have required sections
    if (filePath.includes('/skills/') && filePath.endsWith('.md')) {
      const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!frontmatterMatch || !frontmatterMatch[1].includes('name:')) {
        issues.push({ file: filePath, issue: 'missing-frontmatter', detail: 'Missing YAML frontmatter (name, description)' });
      }

      // Check for at least some content beyond frontmatter
      const fmEnd = content.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/);
      const contentAfterFrontmatter = fmEnd ? content.slice(fmEnd[0].length).trim() : content.trim();
      if (contentAfterFrontmatter.length < 50) {
        issues.push({ file: filePath, issue: 'too-short', detail: 'Skill content is too short (< 50 chars after frontmatter)' });
      }

      // Validate required sections for domain skills (not base)
      const isBase = contentAfterFrontmatter.includes('**base skill**');
      if (!isBase) {
        const requiredSections = ['Activation', 'Key Files', 'Key Concepts', 'Critical Rules'];
        const missing = requiredSections.filter(s => !new RegExp(`^#+\\s*${s}\\b`, 'm').test(contentAfterFrontmatter));
        if (missing.length > 0) {
          issues.push({ file: filePath, issue: 'missing-sections', detail: `Missing sections: ${missing.join(', ')}` });
        }
      }
    }

    // Validate referenced file paths exist (check paths in backticks)
    if (repoPath && filePath.includes('/skills/')) {
      const referencedPaths = [...content.matchAll(/`([^`]+\.[a-z]{1,8})`/g)]
        .map(m => m[1])
        .filter(p => p.startsWith('src/') || p.startsWith('bin/') || p.startsWith('tests/') || p.startsWith('app/'));

      for (const refPath of referencedPaths) {
        // Skip glob patterns and path traversal
        if (refPath.includes('*') || refPath.includes('?') || refPath.includes('..')) continue;
        const resolved = resolve(repoPath, refPath);
        const rel = relative(repoPath, resolved);
        if (rel.startsWith('..') || rel.startsWith(sep)) continue;
        if (!existsSync(resolved)) {
          issues.push({ file: filePath, issue: 'bad-path', detail: `Referenced path \`${refPath}\` does not exist` });
        }
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Handle a stream-json event — call onActivity for tool use events.
 */
function handleStreamEvent(event, onActivity) {
  if (!onActivity) return;

  // Tool use events
  if (event.type === 'assistant' && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === 'tool_use') {
        const tool = block.name;
        const input = block.input || {};
        if (tool === 'Read' && input.file_path) {
          onActivity(`Reading ${input.file_path.split('/').slice(-2).join('/')}`);
        } else if (tool === 'Glob' && input.pattern) {
          onActivity(`Searching for ${input.pattern}`);
        } else if (tool === 'Grep' && input.pattern) {
          onActivity(`Searching code for "${input.pattern}"`);
        } else {
          onActivity(`Using ${tool}`);
        }
      }
    }
  }
}

/**
 * Extract text and token usage from stream-json output.
 * Returns { text, usage }
 */
export function extractResultFromStream(rawOutput) {
  const lines = rawOutput.split('\n').filter(l => l.trim());
  const textParts = [];
  let usage = { output_tokens: 0, tool_uses: 0, tool_result_chars: 0 };

  // Write raw events to debug file if ASPENS_DEBUG is set
  if (process.env.ASPENS_DEBUG) {
    try {
      writeFileSync(join(tmpdir(), 'aspens-debug-stream.json'), rawOutput);
    } catch {}
  }

  for (const line of lines) {
    try {
      const event = JSON.parse(line);

      // Result event — has final text and cumulative usage
      if (event.type === 'result') {
        if (event.usage) {
          usage.output_tokens = event.usage.output_tokens || 0;
        }
        if (event.result) {
          return { text: event.result, usage };
        }
      }

      // Accumulate text from assistant messages and count tool uses
      if (event.type === 'assistant' && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'text') {
            textParts.push(block.text);
          } else if (block.type === 'tool_use') {
            usage.tool_uses++;
          }
        }
      }

      // Measure tool results (what Claude read from the repo)
      if (event.type === 'user' && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) {
          if (block.type === 'tool_result' && typeof block.content === 'string') {
            usage.tool_result_chars += block.content.length;
          }
        }
      }

      // Capture output usage from any event that has it
      if (event.usage) {
        usage.output_tokens = event.usage.output_tokens || 0;
      }
    } catch {
      // not JSON
    }
  }

  return { text: textParts.join('\n'), usage };
}

/**
 * Validate and sanitize a file path from Claude output.
 * Prevents path traversal and restricts to allowed locations.
 */
function sanitizePath(rawPath, allowedPaths) {
  const normalized = normalize(rawPath).replace(/\\/g, '/');

  // Block absolute paths (Unix / and Windows C:\ patterns)
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null;

  // Block traversal
  if (normalized.includes('..')) return null;

  const exactFiles = allowedPaths?.exactFiles ?? DEFAULT_ALLOWED_EXACT_FILES;
  const dirPrefixes = allowedPaths?.dirPrefixes ?? DEFAULT_ALLOWED_DIR_PREFIXES;

  // Allow exact file matches (e.g., CLAUDE.md but not CLAUDE.md.bak)
  if (exactFiles.includes(normalized)) return normalized;

  // Allow paths under allowed directory prefixes
  if (dirPrefixes.some(prefix => normalized.startsWith(prefix))) return normalized;

  return null;
}
