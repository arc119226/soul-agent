import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { join, basename } from 'node:path';
import { mkdirSync } from 'node:fs';
import { config } from '../config.js';
import { logger } from '../core/logger.js';

/**
 * Clean working directory for lightweight CLI calls (classifiers, workers, diary, dreams).
 * Running in a directory without CLAUDE.md avoids auto-loading ~200K tokens of project context,
 * which can overflow Haiku's context window and waste cache tokens on Sonnet.
 */
export const LIGHTWEIGHT_CWD = join(process.cwd(), 'data', 'agent-workspace');

// Ensure the directory exists at import time
try { mkdirSync(LIGHTWEIGHT_CWD, { recursive: true }); } catch { /* ignore */ }

/** Empty plugin directory — prevents Claude CLI from loading global plugins (saves 2-5K tokens/call) */
export const EMPTY_PLUGIN_DIR = join(LIGHTWEIGHT_CWD, '.empty-plugins');
try { mkdirSync(EMPTY_PLUGIN_DIR, { recursive: true }); } catch { /* ignore */ }
import {
  getOrCreateSession,
  clearSessionId,
  setSessionId,
  setCwd as storeCwd,
  getCwd as storeCwd_get,
  updateSession,
} from './session-store.js';
import { ok, fail, type Result } from '../result.js';
import { clearSessionApprovals } from './approval-server.js';

export interface ClaudeCodeResult {
  result: string;
  costUsd: number;
  sessionId: string | null;
  duration: number;
  numTurns: number;
  /** True when CLI exited because it used all allotted turns (subtype: error_max_turns) */
  maxTurnsHit?: boolean;
}

/** Progress event emitted during streaming execution */
export interface StreamProgress {
  /** What Claude is doing right now */
  type: 'tool_use' | 'text' | 'thinking';
  /** Human-readable summary of current activity */
  summary: string;
  /** Full response text so far (only present when type='text') */
  fullText?: string;
}

export interface AskOptions {
  systemPrompt?: string;
  maxTurns?: number;
  timeout?: number;
  /** Called during execution with progress updates (streaming mode) */
  onProgress?: (progress: StreamProgress) => void;
  /** Override model for this call (takes priority over session.model and config) */
  model?: string;
  /** Skip --resume flag (used for classifier calls and haiku responses) */
  skipResume?: boolean;
  /** Override working directory (avoids loading project CLAUDE.md for lightweight agents) */
  cwd?: string;
  /** Path to a JSON file with MCP server config (passed as --mcp-config to Claude CLI) */
  mcpConfig?: string;
  /** Internal: prevents recursive model escalation on error_max_turns */
  _isEscalation?: boolean;
}

/** Per-user runtime state (not persisted) */
interface RuntimeState {
  childProcess: ChildProcess | null;
  busyPromise: Promise<void> | null;
  busyResolve: (() => void) | null;
}

const runtimeState = new Map<number, RuntimeState>();

function getRuntime(userId: number): RuntimeState {
  let rt = runtimeState.get(userId);
  if (!rt) {
    rt = { childProcess: null, busyPromise: null, busyResolve: null };
    runtimeState.set(userId, rt);
  }
  return rt;
}

// ── Model escalation on error_max_turns ──────────────────────────────

/**
 * Get a stronger model when the current one hits max_turns.
 * Returns null if already at the strongest tier or model is unknown.
 */
function escalateModel(currentModel: string): string | null {
  const haiku = config.MODEL_TIER_HAIKU;
  const sonnet = config.MODEL_TIER_SONNET;
  const opus = config.MODEL_TIER_OPUS || 'claude-opus-4-6';

  // Exact match
  if (currentModel === haiku) return sonnet;
  if (currentModel === sonnet) return opus;

  // Fuzzy match (in case model IDs change)
  if (currentModel.includes('haiku')) return sonnet;
  if (currentModel.includes('sonnet')) return opus;

  // Already opus or unknown — can't escalate
  return null;
}

// ── Session staleness & error diagnostics ────────────────────────────

/** Maximum session age before skipping --resume (2 hours) */
const SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** Check if a session is too old to resume reliably */
function isSessionStale(lastUsed: string): boolean {
  try {
    const age = Date.now() - new Date(lastUsed).getTime();
    return age > SESSION_MAX_AGE_MS;
  } catch {
    return true; // Invalid date = treat as stale
  }
}

/** Parse stderr for known error patterns and provide actionable diagnostics */
function diagnoseError(code: number | null, stderr: string): { message: string; fixHint?: string } {
  const lower = stderr.toLowerCase();

  if (lower.includes('rate limit') || lower.includes('429')) {
    return { message: 'API rate limit reached', fixHint: 'Wait a moment and try again.' };
  }
  if (lower.includes('overloaded') || lower.includes('529') || lower.includes('503')) {
    return { message: 'Claude API is overloaded', fixHint: 'The API is temporarily overloaded. Try again in a few minutes.' };
  }
  if (lower.includes('authentication') || lower.includes('401') || lower.includes('api key')) {
    const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
    const fixHint = hasApiKey
      ? 'ANTHROPIC_API_KEY is set but rejected — regenerate at console.anthropic.com.'
      : 'Claude CLI session may have expired. Run "claude login" to re-authenticate.';
    return { message: 'Authentication error', fixHint };
  }
  if (lower.includes('context') || lower.includes('too long') || lower.includes('exceeded') || lower.includes('token')) {
    return { message: `Context overflow (code ${code})`, fixHint: 'Context too large. Use /new to start a fresh session.' };
  }

  return { message: `Claude Code exited with code ${code}: ${stderr.slice(0, 300)}` };
}

// ── Tool name → friendly Chinese label ──────────────────────────────

const TOOL_LABELS: Record<string, string> = {
  Read: '📖 讀取檔案',
  Write: '📝 寫入檔案',
  Edit: '✏️ 編輯檔案',
  Bash: '💻 執行命令',
  Glob: '🔍 搜尋檔案',
  Grep: '🔎 搜尋內容',
  WebFetch: '🌐 抓取網頁',
  WebSearch: '🔍 搜尋網路',
  Task: '🤖 啟動子代理',
  TodoWrite: '📋 更新待辦',
  NotebookEdit: '📓 編輯筆記本',
};

function toolLabel(toolName: string): string {
  return TOOL_LABELS[toolName] ?? `🔧 ${toolName}`;
}

/**
 * Summarize a stream-json assistant message into a human-readable progress string.
 */
function summarizeAssistantMessage(msg: Record<string, unknown>): StreamProgress | null {
  const message = msg.message as Record<string, unknown> | undefined;
  if (!message) return null;

  const content = message.content as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(content) || content.length === 0) return null;

  // Collect all block types first, then prioritize: tool_use > text > thinking
  let toolResult: StreamProgress | null = null;
  let textResult: StreamProgress | null = null;
  let thinkingResult: StreamProgress | null = null;

  for (const block of content) {
    if (block.type === 'tool_use' && !toolResult) {
      const name = block.name as string;
      const input = block.input as Record<string, unknown> | undefined;

      let detail = '';
      if (input) {
        // Extract useful context from tool input
        if (input.file_path) {
          const fp = String(input.file_path);
          detail = basename(fp);
        } else if (input.command) {
          const cmd = String(input.command);
          detail = cmd.length > 40 ? cmd.slice(0, 37) + '...' : cmd;
        } else if (input.pattern) {
          detail = String(input.pattern);
        } else if (input.query) {
          const q = String(input.query);
          detail = q.length > 40 ? q.slice(0, 37) + '...' : q;
        } else if (input.prompt) {
          const p = String(input.prompt);
          detail = p.length > 40 ? p.slice(0, 37) + '...' : p;
        }
      }

      const summary = detail
        ? `${toolLabel(name)}：${detail}`
        : toolLabel(name);

      toolResult = { type: 'tool_use', summary };
    }

    if (block.type === 'text' && !textResult) {
      const text = String(block.text ?? '');
      if (text.length > 0) {
        const preview = text.length > 60 ? text.slice(0, 57) + '...' : text;
        textResult = { type: 'text', summary: `💬 ${preview}`, fullText: text };
      }
    }

    if (block.type === 'thinking' && !thinkingResult) {
      thinkingResult = { type: 'thinking', summary: '🧠 思考中...' };
    }
  }

  return toolResult ?? textResult ?? thinkingResult ?? null;
}

/**
 * Spawn Claude Code CLI with full tool access and session continuity.
 * Uses stream-json output format for real-time progress updates.
 * Only one execution per user at a time (busy lock).
 *
 * Self-healing: if the CLI exits with code 1 while using --resume,
 * the stale session is cleared and the call is retried once without resume.
 */
export async function askClaudeCode(
  prompt: string,
  userId: number,
  opts?: AskOptions,
): Promise<Result<ClaudeCodeResult>> {
  const rt = getRuntime(userId);

  // Busy lock: reject if already running
  if (rt.busyPromise) {
    return fail('Claude Code is busy processing another request', 'Wait for it to finish or use /cc abort');
  }

  // Acquire lock
  let resolveBusy!: () => void;
  rt.busyPromise = new Promise<void>((r) => { resolveBusy = r; });
  rt.busyResolve = resolveBusy;
  const releaseLock = () => {
    resolveBusy();
    rt.busyPromise = null;
    rt.busyResolve = null;
  };

  try {
    const session = getOrCreateSession(userId);

    // Determine if we should attempt --resume
    let attemptResume = !!(session.sessionId && !opts?.skipResume);

    // Proactively skip resume if session is stale (>2h old)
    if (attemptResume && isSessionStale(session.lastUsed)) {
      logger.info('claude-code', `Session ${session.sessionId} is stale (>${SESSION_MAX_AGE_MS / 3_600_000}h), starting fresh`);
      if (session.sessionId) clearSessionApprovals(session.sessionId);
      clearSessionId(userId);
      attemptResume = false;
    }

    // First attempt
    const result = await spawnClaudeOnce(prompt, userId, rt, opts, attemptResume);

    // Self-healing: if failed while using --resume, clear session and retry once
    if (!result.ok && attemptResume) {
      logger.warn('claude-code', `Failed with --resume, retrying without resume: ${result.error.slice(0, 200)}`);
      clearSessionId(userId);
      const retryResult = await spawnClaudeOnce(prompt, userId, rt, opts, false);
      releaseLock();
      return retryResult;
    }

    // Auto-escalate: if max_turns hit, retry with a stronger model (once only)
    if (result.ok && result.value.maxTurnsHit && !opts?._isEscalation) {
      const currentModel = opts?.model || session.model || config.CLAUDE_CODE_MODEL || '';
      const escalated = escalateModel(currentModel);
      if (escalated) {
        logger.info('claude-code',
          `error_max_turns after ${result.value.numTurns} turns (model: ${currentModel || 'default'}), escalating to ${escalated}`);
        clearSessionId(userId);
        const escalatedResult = await spawnClaudeOnce(prompt, userId, rt, {
          ...opts,
          model: escalated,
          skipResume: true,
          _isEscalation: true,
        }, false);
        releaseLock();
        return escalatedResult;
      }
      logger.warn('claude-code',
        `error_max_turns but no stronger model available (current: ${currentModel || 'default'})`);
    }

    releaseLock();
    return result;
  } catch (err) {
    releaseLock();
    return fail(`Unexpected error: ${(err as Error).message}`);
  }
}

/**
 * Internal: spawn a single Claude Code CLI process.
 * Does NOT manage the busy lock — caller is responsible.
 */
function spawnClaudeOnce(
  prompt: string,
  userId: number,
  rt: RuntimeState,
  opts: AskOptions | undefined,
  useResume: boolean,
): Promise<Result<ClaudeCodeResult>> {
  const session = getOrCreateSession(userId);
  const startTime = Date.now();
  const useStreaming = !!opts?.onProgress;

  return new Promise<Result<ClaudeCodeResult>>((resolve) => {
    let settled = false;

    const outputFormat = useStreaming ? 'stream-json' : 'json';
    const args: string[] = ['--print', '--output-format', outputFormat, '--dangerously-skip-permissions'];

    // stream-json requires --verbose
    if (useStreaming) {
      args.push('--verbose');
    }

    // Session continuity
    if (useResume && session.sessionId) {
      args.push('--resume', session.sessionId);
      logger.info('claude-code', `Resuming session: ${session.sessionId}`);
    } else {
      logger.info('claude-code', opts?.skipResume ? 'Skipping resume (skipResume)' : 'Starting new session');
    }

    // Model override: opts.model > session.model > config
    const model = opts?.model || session.model || config.CLAUDE_CODE_MODEL;
    if (model) {
      args.push('--model', model);
    }

    // Max turns
    const maxTurns = opts?.maxTurns ?? config.CLAUDE_CODE_MAX_TURNS;
    if (maxTurns > 0) {
      args.push('--max-turns', String(maxTurns));
    }

    // System prompt
    if (opts?.systemPrompt) {
      args.push('--append-system-prompt', opts.systemPrompt);
    }

    // MCP config override (e.g. LSP tools for code-heavy agents)
    if (opts?.mcpConfig) {
      args.push('--mcp-config', opts.mcpConfig);
    }

    // ── Token isolation: reduce unnecessary context injection ──
    // Only load project-level settings (skip user-level settings that add tokens)
    args.push('--setting-sources', 'project');
    // Point plugin-dir to empty directory to prevent global plugin loading
    args.push('--plugin-dir', EMPTY_PLUGIN_DIR);

    const env = { ...process.env, TELEGRAM_BOT_SESSION: '1' };

    const child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      cwd: opts?.cwd || session.cwd,
      env,
    });

    rt.childProcess = child;

    let stderr = '';
    // Variables to capture result from stream
    let streamResult: Record<string, unknown> | null = null;
    // Accumulate assistant text blocks as fallback for empty result
    let accumulatedText = '';
    // Non-streaming fallback: accumulate full stdout
    let stdout = '';
    const MAX_STDOUT = 10 * 1024 * 1024; // 10MB
    // Track readline interface for cleanup (prevents memory leak)
    let rl: ReadlineInterface | null = null;

    if (useStreaming) {
      // ── Streaming mode: parse JSONL line by line ──
      rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });

      rl.on('line', (line) => {
        if (!line.trim()) return;
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;

          if (obj.type === 'assistant') {
            if (opts?.onProgress) {
              const progress = summarizeAssistantMessage(obj);
              if (progress) {
                opts.onProgress(progress);
              }
            }

            // Accumulate text blocks as fallback for long-running tasks
            // where the final result line may have an empty result field
            const message = obj.message as Record<string, unknown> | undefined;
            const content = message?.content as Array<Record<string, unknown>> | undefined;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'text' && typeof block.text === 'string') {
                  accumulatedText = block.text; // Keep latest text (not append — final text is the answer)
                }
              }
            }
          }

          // Capture the result line for final parsing
          if (obj.type === 'result') {
            streamResult = obj;
          }

          // Save session_id from any message
          if (obj.session_id && typeof obj.session_id === 'string') {
            setSessionId(userId, obj.session_id);
          }
        } catch {
          // Malformed JSON line, skip
        }
      });
    } else {
      // ── Non-streaming: accumulate stdout as before ──
      child.stdout!.on('data', (chunk: Buffer) => {
        if (stdout.length < MAX_STDOUT) stdout += chunk.toString();
      });
    }

    child.stderr!.on('data', (chunk: Buffer) => {
      if (stderr.length < 100_000) stderr += chunk.toString();
    });

    // Suppress EPIPE if child exits early
    child.stdin!.on('error', () => {});
    child.stdin!.write(prompt, 'utf8');
    child.stdin!.end();

    // Timeout
    const timeout = opts?.timeout ?? config.CLAUDE_CODE_TIMEOUT;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      if (rl) { rl.close(); rl = null; }
      if (settled) return;
      settled = true;
      rt.childProcess = null;
      if (session.sessionId) clearSessionApprovals(session.sessionId);
      resolve(fail(`Claude Code timed out after ${timeout}ms`, `Increase CLAUDE_CODE_TIMEOUT or simplify the prompt`));
      logger.warn('claude-code', `Timed out after ${Date.now() - startTime}ms`);
    }, timeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (rl) { rl.close(); rl = null; }
      rt.childProcess = null;
      if (settled) return;
      settled = true;

      const duration = Date.now() - startTime;

      logger.info('claude-code', `Exit code: ${code}, duration: ${duration}ms`);

      // code 0 = normal, code 2 = continue (from stop hook)
      if (code !== 0 && code !== 2) {
        logger.error('claude-code', `Error exit code ${code}`, stderr.slice(0, 500));
        const diag = diagnoseError(code, stderr);
        resolve(fail(diag.message, diag.fixHint));
        return;
      }

      if (useStreaming) {
        // ── Streaming: use captured result ──
        if (streamResult) {
          const sid = streamResult.session_id as string | undefined;
          if (sid) {
            setSessionId(userId, sid);
            logger.info('claude-code', `Session ID saved: ${sid}`);
          }

          const maxTurnsHit = (streamResult.subtype as string) === 'error_max_turns';

          resolve(ok('Claude Code completed', {
            result: (streamResult.result as string) || accumulatedText || '(no response)',
            sessionId: sid ?? null,
            costUsd: (streamResult.total_cost_usd as number) || 0,
            numTurns: (streamResult.num_turns as number) || 1,
            duration,
            maxTurnsHit,
          }));
        } else {
          resolve(ok('Claude Code completed (no result captured)', {
            result: accumulatedText || '(no response)',
            sessionId: null,
            costUsd: 0,
            numTurns: 0,
            duration,
          }));
        }
      } else {
        // ── Non-streaming: parse JSON as before ──
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          const lines = stdout.trim().split('\n');
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              parsed = JSON.parse(lines[i]!);
              break;
            } catch {
              continue;
            }
          }
        }

        if (parsed) {
          const sid = parsed.session_id as string | undefined;
          if (sid) {
            setSessionId(userId, sid);
            logger.info('claude-code', `Session ID saved: ${sid}`);
          }

          const maxTurnsHit = (parsed.subtype as string) === 'error_max_turns';

          resolve(ok('Claude Code completed', {
            result: (parsed.result as string) || stdout.trim(),
            sessionId: sid ?? null,
            costUsd: (parsed.total_cost_usd as number) || 0,
            numTurns: (parsed.num_turns as number) || 1,
            duration,
            maxTurnsHit,
          }));
        } else {
          logger.warn('claude-code', `JSON parse failed. Raw (first 300): ${stdout.slice(0, 300)}`);
          resolve(ok('Claude Code completed (raw output)', {
            result: stdout.trim() || '(no response)',
            sessionId: null,
            costUsd: 0,
            numTurns: 0,
            duration,
          }));
        }
      }
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (rl) { rl.close(); rl = null; }
      rt.childProcess = null;
      if (settled) return;
      settled = true;

      if (err.code === 'ENOENT') {
        resolve(fail('Claude CLI not found', 'Make sure "claude" is installed and in PATH'));
      } else {
        resolve(fail(`Failed to spawn Claude CLI: ${err.message}`));
      }
    });
  });
}

/** Kill the running Claude Code process for a user. */
export function abortClaudeCode(userId: number): boolean {
  const rt = runtimeState.get(userId);
  if (!rt?.childProcess) return false;
  rt.childProcess.kill('SIGTERM');
  return true;
}

/** Clear session to start fresh */
export function newSession(userId: number): void {
  // Clear auto-approve patterns to prevent leak across sessions
  const session = getOrCreateSession(userId);
  if (session.sessionId) clearSessionApprovals(session.sessionId);
  clearSessionId(userId);
}

/** Resume a specific session */
export function resumeSession(userId: number, sessionId: string): void {
  setSessionId(userId, sessionId);
}

/** Get working directory */
export function getCwd(userId: number): string {
  return storeCwd_get(userId);
}

/** Set working directory */
export function setCwd(userId: number, cwd: string): void {
  storeCwd(userId, cwd);
}

/** Check if user has a running process */
export function isBusy(userId: number): boolean {
  const rt = runtimeState.get(userId);
  return rt ? rt.busyPromise !== null : false;
}

/** Get session info for display */
export function getSessionInfo(userId: number): {
  sessionId: string | null;
  cwd: string;
  model: string;
  busy: boolean;
  lastUsed: string;
} {
  const session = getOrCreateSession(userId);
  return {
    sessionId: session.sessionId,
    cwd: session.cwd,
    model: session.model,
    busy: isBusy(userId),
    lastUsed: session.lastUsed,
  };
}
