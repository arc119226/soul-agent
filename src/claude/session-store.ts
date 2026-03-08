import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../core/logger.js';
import { writer } from '../core/debounced-writer.js';
import { config } from '../config.js';

const SESSION_FILE = join(process.cwd(), 'soul', 'sessions.json');

export interface SessionState {
  sessionId: string | null;
  cwd: string;
  model: string;
  lastUsed: string;
}

interface SessionFileSchema {
  version: number;
  sessions: Record<string, SessionState>;
}

/** In-memory per-user sessions: Map<userId, SessionState> */
const sessions = new Map<number, SessionState>();

function defaultSession(): SessionState {
  return {
    sessionId: null,
    cwd: config.CLAUDE_CODE_CWD || process.cwd(),
    model: config.CLAUDE_CODE_MODEL || '',
    lastUsed: new Date().toISOString(),
  };
}

/** Load sessions from soul/sessions.json on startup */
export async function loadSessions(): Promise<void> {
  try {
    const raw = await readFile(SESSION_FILE, 'utf-8');
    const data: SessionFileSchema = JSON.parse(raw);
    for (const [uid, state] of Object.entries(data.sessions)) {
      sessions.set(Number(uid), {
        sessionId: state.sessionId ?? null,
        cwd: state.cwd || config.CLAUDE_CODE_CWD || process.cwd(),
        model: state.model || '',
        lastUsed: state.lastUsed || new Date().toISOString(),
      });
    }
    logger.info('session-store', `Loaded ${sessions.size} session(s) from disk`);
  } catch {
    // File doesn't exist or is invalid — start fresh
    logger.info('session-store', 'No existing sessions file, starting fresh');
  }
}

/** Persist all sessions to disk (debounced) */
function saveSessions(): void {
  const data: SessionFileSchema = { version: 1, sessions: {} };
  for (const [uid, state] of sessions) {
    data.sessions[String(uid)] = {
      sessionId: state.sessionId,
      cwd: state.cwd,
      model: state.model,
      lastUsed: state.lastUsed,
    };
  }
  writer.schedule(SESSION_FILE, data);
}

/** Persist immediately (for shutdown) */
export async function flushSessions(): Promise<void> {
  const data: SessionFileSchema = { version: 1, sessions: {} };
  for (const [uid, state] of sessions) {
    data.sessions[String(uid)] = {
      sessionId: state.sessionId,
      cwd: state.cwd,
      model: state.model,
      lastUsed: state.lastUsed,
    };
  }
  await writer.writeNow(SESSION_FILE, data);
}

/** Get or create a session for a user */
export function getOrCreateSession(userId: number): SessionState {
  let session = sessions.get(userId);
  if (!session) {
    session = defaultSession();
    sessions.set(userId, session);
  }
  return session;
}

/** Get session without creating */
export function getSession(userId: number): SessionState | undefined {
  return sessions.get(userId);
}

/** Update session and persist */
export function updateSession(userId: number, patch: Partial<SessionState>): SessionState {
  const session = getOrCreateSession(userId);
  Object.assign(session, patch, { lastUsed: new Date().toISOString() });
  saveSessions();
  return session;
}

/** Clear session ID (new session) */
export function clearSessionId(userId: number): void {
  updateSession(userId, { sessionId: null });
}

/** Set session ID (resume) */
export function setSessionId(userId: number, sessionId: string): void {
  updateSession(userId, { sessionId });
}

/** Set working directory */
export function setCwd(userId: number, cwd: string): void {
  updateSession(userId, { cwd });
}

/** Get working directory */
export function getCwd(userId: number): string {
  return getOrCreateSession(userId).cwd;
}

/** Set model override */
export function setModel(userId: number, model: string): void {
  updateSession(userId, { model });
}
