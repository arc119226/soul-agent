/**
 * Operation grading — classify tool operations into green/yellow/red levels.
 *
 * GREEN  → auto-approve, no logging (read-only, side-effect-free)
 * YELLOW → auto-approve + audit log (data modification, low risk)
 * RED    → require explicit approval via Telegram (system ops, high risk)
 *
 * This module is consumed by approval-server.ts to replace the binary
 * SAFE_TOOLS check with a three-tier classification.
 */

import { join } from 'node:path';
import { writer } from '../core/debounced-writer.js';

/* ── types ─────────────────────────────────── */
export type OperationGrade = 'green' | 'yellow' | 'red';

export interface OperationLogEntry {
  timestamp: string;
  grade: OperationGrade;
  toolName: string;
  /** Truncated summary of tool input for audit trail */
  summary: string;
  sessionId: string;
}

/* ── paths ─────────────────────────────────── */
const OPERATION_LOG_PATH = join(process.cwd(), 'soul', 'operation-log.jsonl');

/* ── tool classification ───────────────────── */

/**
 * GREEN: read-only, side-effect-free tools.
 * Matches the existing SAFE_TOOLS set in approval-server.ts.
 */
const GREEN_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'Task', 'TodoRead', 'TodoWrite',
  'WebSearch', 'WebFetch',
  'mcp__plugin_context7_context7__resolve-library-id',
  'mcp__plugin_context7_context7__query-docs',
  'mcp__bot-tools__web_search',
  'mcp__bot-tools__web_fetch',
  'mcp__bot-tools__soul_read',
  'mcp__bot-tools__list_skills',
  'mcp__claude_ai_Cloudflare_Developer_Platform__search_cloudflare_documentation',
]);

/**
 * YELLOW: data modification tools with low blast radius.
 * Auto-approved but every invocation is logged for audit.
 */
const YELLOW_TOOLS = new Set([
  'Edit', 'Write', 'NotebookEdit',
  'mcp__bot-tools__soul_write',
  'mcp__bot-tools__create_skill',
  'mcp__bot-tools__update_skill',
  'mcp__bot-tools__delete_skill',
]);

/**
 * Classify a Bash command into operation grade.
 * Read-only commands → green; git-read/npm-read → green;
 * dangerous commands → red; everything else → yellow.
 */
function classifyBashCommand(command: string): OperationGrade {
  const trimmed = command.trim();

  // Green: read-only bash commands
  const greenPatterns = [
    /^(ls|pwd|echo|cat|head|tail|wc|du|df|which|whoami|date|hostname)\b/,
    /^git\s+(status|log|diff|show|branch|tag\s+-l|remote\s+-v|rev-parse)\b/,
    /^npm\s+(ls|list|view|info|outdated|audit)\b/,
    /^npx\s+tsc\s+--noEmit\b/,
    /^node\s+-[ep]\b/,
  ];
  if (greenPatterns.some((p) => p.test(trimmed))) return 'green';

  // Red: dangerous commands (matches existing isDangerous patterns)
  const redPatterns = [
    /\brm\s+(-\w+\s+)*\//,
    /\brm\s+-rf\b/,
    /\bgit\s+push\b/,
    /\bgit\s+reset\s+--hard\b/,
    /\bgit\s+push\s+--force\b/,
    /\bgit\s+push\s+-f\b/,
    /\bkill\b/, /\bpkill\b/, /\bkillall\b/,
    /\bsudo\b/, /\bchmod\b/, /\bchown\b/,
    /\bdd\s+/, /\bmkfs\b/, />\s*\/dev\//,
    /\bnpm\s+(publish|unpublish)\b/,
    /\bcurl\s+.*(-X\s*(POST|PUT|DELETE|PATCH)|-d\s)/,
  ];
  if (redPatterns.some((p) => p.test(trimmed))) return 'red';

  // Yellow: everything else (git commit, npm install, mkdir, etc.)
  return 'yellow';
}

/* ── public API ────────────────────────────── */

/**
 * Classify a tool invocation into an operation grade.
 */
export function getOperationGrade(
  toolName: string,
  toolInput: Record<string, unknown>,
): OperationGrade {
  if (GREEN_TOOLS.has(toolName)) return 'green';
  if (YELLOW_TOOLS.has(toolName)) return 'yellow';
  if (toolName === 'Bash') {
    return classifyBashCommand(String(toolInput.command ?? ''));
  }
  // Unknown tools default to red (safe default)
  return 'red';
}

/**
 * Log a yellow operation to the audit trail.
 */
export async function logOperation(
  grade: OperationGrade,
  toolName: string,
  toolInput: Record<string, unknown>,
  sessionId: string,
): Promise<void> {
  // Only log yellow and red operations (green is noise)
  if (grade === 'green') return;

  const summary = buildSummary(toolName, toolInput);
  const entry: OperationLogEntry = {
    timestamp: new Date().toISOString(),
    grade,
    toolName,
    summary,
    sessionId: sessionId.slice(0, 8),
  };

  await writer.appendJsonl(OPERATION_LOG_PATH, entry);
}

/**
 * Build a human-readable summary of a tool invocation (truncated for audit).
 */
function buildSummary(toolName: string, toolInput: Record<string, unknown>): string {
  if (toolName === 'Bash') {
    const cmd = String(toolInput.command ?? '');
    return cmd.length > 120 ? cmd.slice(0, 120) + '...' : cmd;
  }
  if (toolName === 'Edit' || toolName === 'Write') {
    return String(toolInput.file_path ?? '(unknown file)');
  }
  // Generic: JSON keys
  const keys = Object.keys(toolInput).slice(0, 3).join(', ');
  return `${toolName}(${keys})`.slice(0, 120);
}
