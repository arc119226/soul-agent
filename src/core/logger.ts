import { appendFile, stat, rename, mkdir, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const LOGS_DIR = join(process.cwd(), 'data', 'logs');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_ARCHIVES = 3;
const MAX_LOGS_DIR_SIZE = 50 * 1024 * 1024; // 50MB

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  data?: unknown;
}

class Logger {
  private initialized = false;

  private async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(LOGS_DIR, { recursive: true });
    this.initialized = true;
    // Startup cleanup of oversized chat logs
    this.cleanupLogsDir().catch(() => {});
  }

  async log(level: LogLevel, module: string, message: string, data?: unknown): Promise<void> {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module,
      message,
      ...(data !== undefined && { data }),
    };

    // Console output
    const prefix = `[${entry.timestamp}] [${level.toUpperCase()}] [${module}]`;
    if (level === 'error') {
      console.error(`${prefix} ${message}`, data ?? '');
    } else if (level === 'warn') {
      console.warn(`${prefix} ${message}`, data ?? '');
    } else {
      console.log(`${prefix} ${message}`);
    }

    // File output
    try {
      await this.init();
      const logFile = join(LOGS_DIR, 'bot.jsonl');
      await appendFile(logFile, JSON.stringify(entry) + '\n', 'utf-8');
      await this.rotateIfNeeded(logFile);
    } catch {
      // Don't throw on log failures
    }
  }

  /** Log a chat message */
  async logChat(chatId: number, userId: number, role: 'user' | 'bot', text: string): Promise<void> {
    await this.init();
    const prefix = chatId > 0 ? 'pm' : 'group';
    const file = join(LOGS_DIR, `${prefix}_${Math.abs(chatId)}.jsonl`);
    const entry = {
      timestamp: new Date().toISOString(),
      userId,
      role,
      text: text.slice(0, 5000), // cap log entry size
    };
    try {
      await appendFile(file, JSON.stringify(entry) + '\n', 'utf-8');
    } catch {
      // Don't throw on log failures
    }
  }

  debug(module: string, message: string, data?: unknown) {
    return this.log('debug', module, message, data);
  }
  info(module: string, message: string, data?: unknown) {
    return this.log('info', module, message, data);
  }
  warn(module: string, message: string, data?: unknown) {
    return this.log('warn', module, message, data);
  }
  error(module: string, message: string, data?: unknown) {
    return this.log('error', module, message, data);
  }

  private async rotateIfNeeded(filePath: string): Promise<void> {
    try {
      const s = await stat(filePath);
      if (s.size < MAX_LOG_SIZE) return;

      // Rotate archives
      const dir = join(LOGS_DIR);
      const files = await readdir(dir);
      const base = 'bot';
      const archives = files
        .filter((f) => f.startsWith(`${base}.`) && f.endsWith('.jsonl') && f !== `${base}.jsonl`)
        .sort()
        .reverse();

      // Remove excess archives
      for (let i = MAX_ARCHIVES - 1; i < archives.length; i++) {
        await unlink(join(dir, archives[i]!));
      }

      // Rename current to archive
      const archiveName = `${base}.${Date.now()}.jsonl`;
      await rename(filePath, join(dir, archiveName));

      // Also clean up oversized chat logs after rotation
      this.cleanupLogsDir().catch(() => {});
    } catch {
      // Rotation failure is non-fatal
    }
  }

  /**
   * Clean up chat log files when total logs dir exceeds MAX_LOGS_DIR_SIZE.
   * Deletes oldest files first, but never deletes bot.jsonl.
   */
  private async cleanupLogsDir(): Promise<void> {
    try {
      const files = await readdir(LOGS_DIR);
      const fileInfos: Array<{ name: string; path: string; size: number; mtime: number }> = [];
      let totalSize = 0;

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const fullPath = join(LOGS_DIR, file);
        try {
          const s = await stat(fullPath);
          fileInfos.push({ name: file, path: fullPath, size: s.size, mtime: s.mtimeMs });
          totalSize += s.size;
        } catch {
          // stat failed — skip
        }
      }

      if (totalSize <= MAX_LOGS_DIR_SIZE) return;

      // Sort oldest first
      fileInfos.sort((a, b) => a.mtime - b.mtime);

      let deleted = 0;
      for (const info of fileInfos) {
        if (totalSize <= MAX_LOGS_DIR_SIZE) break;
        if (info.name === 'bot.jsonl') continue; // protect main log
        await unlink(info.path).catch(() => {});
        totalSize -= info.size;
        deleted++;
      }

      if (deleted > 0) {
        console.log(`[Logger] Cleaned up ${deleted} old log file(s), freed space`);
      }
    } catch {
      // Non-fatal
    }
  }
}

export const logger = new Logger();
