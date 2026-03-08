import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../core/logger.js';

// Shared secret for IPC authentication (set in env for Claude Code hooks to use)
const APPROVAL_SECRET = randomBytes(16).toString('hex');
process.env.APPROVAL_SECRET = APPROVAL_SECRET;

// --- Types ---

interface PendingApproval {
  toolName: string;
  toolInput: Record<string, unknown>;
  sessionId: string;
  decision: 'allow' | 'deny' | null;
  createdAt: number;
  telegramMessageId: number | null;
}

interface PendingPlanApproval {
  sessionId: string;
  decision: 'confirm' | 'auto_allow' | 'deny' | null;
  createdAt: number;
  telegramMessageId: number | null;
}

interface QuestionOption {
  label: string;
  description: string;
}

interface QuestionItem {
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
  header?: string;
}

interface PendingQuestion {
  sessionId: string;
  questions: QuestionItem[];
  answers: Record<string, string> | null; // null = unanswered
  createdAt: number;
  telegramMessageId: number | null;
}

export type ApprovalRequestHandler = (
  requestId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
) => void;

export type PlanApprovalHandler = (
  requestId: string,
  planContent: string,
) => void;

export type QuestionRequestHandler = (
  requestId: string,
  questions: QuestionItem[],
) => void;

export type CompleteHandler = (summary: string) => void;

// --- State ---

const pendingApprovals = new Map<string, PendingApproval>();
const pendingPlanApprovals = new Map<string, PendingPlanApproval>();
const pendingQuestions = new Map<string, PendingQuestion>();

/** Per-session auto-approved tool patterns (from "Allow Similar") */
const autoApprovedPatterns = new Map<string, Set<string>>();

/** Sessions that auto-approve all tools (from plan "Auto Allow") */
const sessionAutoApproveAll = new Set<string>();

let onApprovalRequest: ApprovalRequestHandler | null = null;
let onPlanApproval: PlanApprovalHandler | null = null;
let onQuestionRequest: QuestionRequestHandler | null = null;
let onComplete: CompleteHandler | null = null;

// --- Auto-Approve Logic ---

/**
 * Generate a pattern key for a tool invocation.
 * - Bash → `Bash:{first two words}` (e.g. `Bash:git commit`)
 * - Edit/Write → `{tool}:{file_path}`
 * - Others → tool name
 */
export function getToolPattern(toolName: string, toolInput: Record<string, unknown>): string {
  if (toolName === 'Bash') {
    const cmd = String(toolInput.command ?? '');
    const words = cmd.trim().split(/\s+/).slice(0, 2).join(' ');
    return `Bash:${words}`;
  }
  if (toolName === 'Edit' || toolName === 'Write') {
    return `${toolName}:${String(toolInput.file_path ?? '')}`;
  }
  return toolName;
}

/**
 * Check if a Bash command is potentially dangerous.
 */
export function isDangerous(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (toolName !== 'Bash') return false;
  const cmd = String(toolInput.command ?? '');
  const patterns = [
    /\brm\s+(-\w+\s+)*\//,  // rm with absolute path
    /\brm\s+-rf\b/,
    /\bgit\s+push\b/,
    /\bgit\s+reset\s+--hard\b/,
    /\bgit\s+push\s+--force\b/,
    /\bgit\s+push\s+-f\b/,
    /\bkill\b/,
    /\bpkill\b/,
    /\bkillall\b/,
    /\bsudo\b/,
    /\bchmod\b/,
    /\bchown\b/,
    /\bdd\s+/,
    /\bmkfs\b/,
    />\s*\/dev\//,
  ];
  return patterns.some((p) => p.test(cmd));
}

function isAutoApproved(
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): boolean {
  if (sessionAutoApproveAll.has(sessionId)) return true;
  const patterns = autoApprovedPatterns.get(sessionId);
  if (!patterns) return false;
  return patterns.has(getToolPattern(toolName, toolInput));
}

/** Record a tool pattern as auto-approved for a session ("Allow Similar"). */
export function addAutoApproval(
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): void {
  if (!autoApprovedPatterns.has(sessionId)) {
    autoApprovedPatterns.set(sessionId, new Set());
  }
  autoApprovedPatterns.get(sessionId)!.add(getToolPattern(toolName, toolInput));
}

/** Mark a session as auto-approve-all (from plan approval). */
export function addSessionAutoApproveAll(sessionId: string): void {
  sessionAutoApproveAll.add(sessionId);
}

/** Clear all auto-approve patterns for a session (prevents leak across resumes). */
export function clearSessionApprovals(sessionId: string): void {
  autoApprovedPatterns.delete(sessionId);
  sessionAutoApproveAll.delete(sessionId);
}

/** Read-only tools that are always auto-approved (no Telegram prompt). */
const SAFE_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'Task', 'TodoRead', 'TodoWrite',
  'mcp__plugin_context7_context7__resolve-library-id',
  'mcp__plugin_context7_context7__query-docs',
]);

// --- Rate limiter (sliding window, 20 req/s) ---

const RATE_LIMIT_WINDOW = 1000;
const RATE_LIMIT_MAX = 20;
const requestTimestamps: number[] = [];

function isRateLimited(): boolean {
  const now = Date.now();
  while (requestTimestamps.length > 0 && requestTimestamps[0]! <= now - RATE_LIMIT_WINDOW) {
    requestTimestamps.shift();
  }
  if (requestTimestamps.length >= RATE_LIMIT_MAX) return true;
  requestTimestamps.push(now);
  return false;
}

// --- Helpers ---

function readPostBody(
  req: IncomingMessage,
  res: ServerResponse,
  callback: (data: Record<string, unknown>) => void | Promise<void>,
): void {
  let body = '';
  const MAX_BODY = 1024 * 1024; // 1MB
  let exceeded = false;

  req.on('data', (chunk: Buffer) => {
    body += chunk.toString();
    if (body.length > MAX_BODY) {
      exceeded = true;
      req.destroy();
      res.writeHead(413);
      res.end(JSON.stringify({ error: 'Request body too large' }));
    }
  });

  req.on('end', () => {
    if (exceeded) return;
    try {
      const result = callback(JSON.parse(body));
      if (result instanceof Promise) {
        result.catch(() => {
          if (!res.headersSent) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Internal error' }));
          }
        });
      }
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
  });
}

function jsonResponse(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// --- Public API ---

export function setApprovalHandler(handler: ApprovalRequestHandler): void {
  onApprovalRequest = handler;
}

export function setPlanApprovalHandler(handler: PlanApprovalHandler): void {
  onPlanApproval = handler;
}

export function setQuestionHandler(handler: QuestionRequestHandler): void {
  onQuestionRequest = handler;
}

export function setCompleteHandler(handler: CompleteHandler): void {
  onComplete = handler;
}

export function resolveApproval(requestId: string, decision: 'allow' | 'deny'): boolean {
  const entry = pendingApprovals.get(requestId);
  if (entry && entry.decision === null) {
    entry.decision = decision;
    return true;
  }
  return false;
}

export function resolvePlanApproval(requestId: string, decision: 'confirm' | 'auto_allow' | 'deny'): boolean {
  const entry = pendingPlanApprovals.get(requestId);
  if (entry && entry.decision === null) {
    entry.decision = decision;
    return true;
  }
  return false;
}

export function resolveQuestion(requestId: string, answers: Record<string, string>): boolean {
  const entry = pendingQuestions.get(requestId);
  if (entry && entry.answers === null) {
    entry.answers = answers;
    return true;
  }
  return false;
}

export function getPendingQuestion(requestId: string): PendingQuestion | undefined {
  return pendingQuestions.get(requestId);
}

export function getPendingApproval(requestId: string): PendingApproval | undefined {
  return pendingApprovals.get(requestId);
}

export function getPendingPlanApproval(requestId: string): PendingPlanApproval | undefined {
  return pendingPlanApprovals.get(requestId);
}

export function setPendingMessageId(requestId: string, messageId: number): void {
  const entry = pendingApprovals.get(requestId);
  if (entry) entry.telegramMessageId = messageId;
  const planEntry = pendingPlanApprovals.get(requestId);
  if (planEntry) planEntry.telegramMessageId = messageId;
}

// --- Server ---

let serverInstance: Server | null = null;
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export function startApprovalServer(): Server | null {
  if (!config.APPROVAL_CHAT_ID) {
    logger.info('approval', 'APPROVAL_CHAT_ID not set, approval server disabled');
    return null;
  }

  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');

    // Rate limiting
    if (isRateLimited()) {
      jsonResponse(res, 429, { error: 'Too many requests' });
      return;
    }

    // Validate shared secret
    if (req.headers['x-approval-secret'] !== APPROVAL_SECRET) {
      jsonResponse(res, 403, { error: 'Forbidden' });
      return;
    }

    const url = req.url ?? '';

    // --- Tool Approval ---
    if (req.method === 'POST' && url === '/approve') {
      readPostBody(req, res, async (data) => {
        const requestId = data.requestId as string | undefined;
        const toolName = data.toolName as string | undefined;
        const toolInput = (data.toolInput as Record<string, unknown>) ?? {};
        const sessionId = (data.sessionId as string) ?? '';

        if (!requestId || !toolName) {
          jsonResponse(res, 400, { error: 'Missing requestId or toolName' });
          return;
        }

        // Operation grading: classify into green/yellow/red
        let graded = false;
        try {
          const { getOperationGrade, logOperation } = await import('../safety/operation-grades.js');
          const grade = getOperationGrade(toolName, toolInput);
          graded = true;

          // GREEN: auto-approve, no prompt, no log
          if (grade === 'green') {
            jsonResponse(res, 200, { status: 'auto_approved' });
            return;
          }

          // YELLOW: auto-approve + audit log
          if (grade === 'yellow') {
            logOperation(grade, toolName, toolInput, sessionId).catch(() => {});
            logger.info('approval', `Yellow-approved: ${toolName} (session ${sessionId.slice(0, 8)})`);
            jsonResponse(res, 200, { status: 'auto_approved' });
            return;
          }

          // RED: log + fall through to approval prompt
          logOperation(grade, toolName, toolInput, sessionId).catch(() => {});
        } catch {
          // Fallback to legacy SAFE_TOOLS check if operation-grades unavailable
        }

        if (!graded && SAFE_TOOLS.has(toolName)) {
          jsonResponse(res, 200, { status: 'auto_approved' });
          return;
        }

        // Check session/pattern auto-approve (for RED operations)
        if (isAutoApproved(sessionId, toolName, toolInput)) {
          logger.info('approval', `Auto-approved: ${toolName} (session ${sessionId.slice(0, 8)})`);
          jsonResponse(res, 200, { status: 'auto_approved' });
          return;
        }

        pendingApprovals.set(requestId, {
          toolName,
          toolInput,
          sessionId,
          decision: null,
          createdAt: Date.now(),
          telegramMessageId: null,
        });

        if (onApprovalRequest) {
          onApprovalRequest(requestId, toolName, toolInput);
        }

        jsonResponse(res, 200, { status: 'pending' });
      });

    } else if (req.method === 'GET' && url.startsWith('/approve/')) {
      const requestId = url.slice('/approve/'.length);
      const entry = pendingApprovals.get(requestId);

      if (!entry) {
        jsonResponse(res, 404, { error: 'not_found' });
        return;
      }

      if (entry.decision !== null) {
        pendingApprovals.delete(requestId);
        jsonResponse(res, 200, { status: 'resolved', decision: entry.decision });
        return;
      }

      if (Date.now() - entry.createdAt > config.APPROVAL_TIMEOUT) {
        pendingApprovals.delete(requestId);
        jsonResponse(res, 200, { status: 'timeout' });
        return;
      }

      jsonResponse(res, 200, { status: 'pending' });

    // --- Plan Approval ---
    } else if (req.method === 'POST' && url === '/plan') {
      readPostBody(req, res, (data) => {
        const requestId = data.requestId as string | undefined;
        const sessionId = (data.sessionId as string) ?? '';
        const planContent = (data.planContent as string) ?? '';

        if (!requestId) {
          jsonResponse(res, 400, { error: 'Missing requestId' });
          return;
        }

        pendingPlanApprovals.set(requestId, {
          sessionId,
          decision: null,
          createdAt: Date.now(),
          telegramMessageId: null,
        });

        if (onPlanApproval) {
          onPlanApproval(requestId, planContent);
        }

        jsonResponse(res, 200, { status: 'pending' });
      });

    } else if (req.method === 'GET' && url.startsWith('/plan/')) {
      const requestId = url.slice('/plan/'.length);
      const entry = pendingPlanApprovals.get(requestId);

      if (!entry) {
        jsonResponse(res, 404, { error: 'not_found' });
        return;
      }

      if (entry.decision !== null) {
        pendingPlanApprovals.delete(requestId);
        jsonResponse(res, 200, { status: 'resolved', decision: entry.decision });
        return;
      }

      if (Date.now() - entry.createdAt > config.APPROVAL_TIMEOUT) {
        pendingPlanApprovals.delete(requestId);
        jsonResponse(res, 200, { status: 'timeout' });
        return;
      }

      jsonResponse(res, 200, { status: 'pending' });

    // --- AskUserQuestion ---
    } else if (req.method === 'POST' && url === '/question') {
      readPostBody(req, res, (data) => {
        const requestId = data.requestId as string | undefined;
        const questions = (data.questions as QuestionItem[]) ?? [];
        const sessionId = (data.sessionId as string) ?? '';

        if (!requestId || questions.length === 0) {
          jsonResponse(res, 400, { error: 'Missing requestId or questions' });
          return;
        }

        pendingQuestions.set(requestId, {
          sessionId,
          questions,
          answers: null,
          createdAt: Date.now(),
          telegramMessageId: null,
        });

        if (onQuestionRequest) {
          onQuestionRequest(requestId, questions);
        }

        jsonResponse(res, 200, { status: 'pending' });
      });

    } else if (req.method === 'GET' && url.startsWith('/question/')) {
      const requestId = url.slice('/question/'.length);
      const entry = pendingQuestions.get(requestId);

      if (!entry) {
        jsonResponse(res, 404, { error: 'not_found' });
        return;
      }

      if (entry.answers !== null) {
        pendingQuestions.delete(requestId);
        jsonResponse(res, 200, { status: 'resolved', answers: entry.answers });
        return;
      }

      if (Date.now() - entry.createdAt > config.APPROVAL_TIMEOUT) {
        pendingQuestions.delete(requestId);
        jsonResponse(res, 200, { status: 'timeout' });
        return;
      }

      jsonResponse(res, 200, { status: 'pending' });

    // --- Completion Notification ---
    } else if (req.method === 'POST' && url === '/complete') {
      readPostBody(req, res, (data) => {
        const summary = (data.summary as string) ?? '(no summary)';
        if (onComplete) {
          onComplete(summary);
        }
        jsonResponse(res, 200, { status: 'ok' });
      });

    } else {
      jsonResponse(res, 404, { error: 'Not found' });
    }
  });

  server.listen(config.APPROVAL_PORT, '127.0.0.1', () => {
    logger.info('approval', `Server listening on http://127.0.0.1:${config.APPROVAL_PORT}`);
  });

  server.on('error', (err) => {
    logger.error('approval', 'Server error', err);
  });

  serverInstance = server;

  // Periodic cleanup of stale entries
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    const staleThreshold = config.APPROVAL_TIMEOUT * 2;
    for (const [id, entry] of pendingApprovals) {
      if (now - entry.createdAt > staleThreshold) {
        pendingApprovals.delete(id);
      }
    }
    for (const [id, entry] of pendingPlanApprovals) {
      if (now - entry.createdAt > staleThreshold) {
        pendingPlanApprovals.delete(id);
      }
    }
    for (const [id, entry] of pendingQuestions) {
      if (now - entry.createdAt > staleThreshold) {
        pendingQuestions.delete(id);
      }
    }
    // Auto-approve maps don't need TTL cleanup here
    // They are session-scoped and cleared when sessions end
  }, 5 * 60 * 1000);
  cleanupInterval.unref();

  return server;
}

/** Stop the approval server (for graceful shutdown) */
export function stopApprovalServer(): Promise<void> {
  return new Promise((resolve) => {
    if (cleanupInterval) {
      clearInterval(cleanupInterval);
      cleanupInterval = null;
    }
    if (!serverInstance) {
      resolve();
      return;
    }
    serverInstance.close(() => {
      serverInstance = null;
      logger.info('approval', 'Server stopped');
      resolve();
    });
  });
}
