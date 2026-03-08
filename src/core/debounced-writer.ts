import { writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';

/**
 * Atomic JSON file writer with debounce.
 * Writes to tmp file first, then renames — crash-safe.
 */
export class DebouncedWriter {
  private pending = new Map<string, NodeJS.Timeout>();
  private pendingData = new Map<string, unknown>();
  private writePromises = new Map<string, Promise<void>>();

  constructor(private delayMs: number = 1000) {}

  /** Schedule a debounced atomic write */
  schedule(filePath: string, data: unknown): void {
    const existing = this.pending.get(filePath);
    if (existing) clearTimeout(existing);

    this.pendingData.set(filePath, data);

    const timer = setTimeout(() => {
      this.pending.delete(filePath);
      this.pendingData.delete(filePath);
      const p = this.atomicWrite(filePath, data);
      this.writePromises.set(filePath, p);
      p.finally(() => this.writePromises.delete(filePath));
    }, this.delayMs);

    this.pending.set(filePath, timer);
  }

  /** Write immediately (bypass debounce) */
  async writeNow(filePath: string, data: unknown): Promise<void> {
    const existing = this.pending.get(filePath);
    if (existing) {
      clearTimeout(existing);
      this.pending.delete(filePath);
    }
    this.pendingData.delete(filePath);
    await this.atomicWrite(filePath, data);
  }

  /** Append a line to a JSONL file (atomic append) */
  async appendJsonl(filePath: string, entry: unknown): Promise<void> {
    const dir = dirname(filePath);
    await mkdir(dir, { recursive: true });
    const line = JSON.stringify(entry) + '\n';
    await appendFile(filePath, line, 'utf-8');
  }

  /** Flush all pending writes — actually writes data that was waiting on debounce timers */
  async flush(): Promise<void> {
    // Collect pending data and cancel timers
    const toWrite = new Map<string, unknown>();
    for (const [filePath, timer] of this.pending) {
      clearTimeout(timer);
      const data = this.pendingData.get(filePath);
      if (data !== undefined) toWrite.set(filePath, data);
    }
    this.pending.clear();
    this.pendingData.clear();

    // Write all pending data immediately
    const flushWrites = [...toWrite.entries()].map(([filePath, data]) => {
      const p = this.atomicWrite(filePath, data);
      this.writePromises.set(filePath, p);
      return p.finally(() => this.writePromises.delete(filePath));
    });

    // Wait for flush writes + any previously in-flight writes
    await Promise.allSettled([...this.writePromises.values(), ...flushWrites]);
  }

  private async atomicWrite(filePath: string, data: unknown): Promise<void> {
    const dir = dirname(filePath);
    await mkdir(dir, { recursive: true });
    const tmpPath = join(dir, `.tmp-${randomUUID()}`);
    const content = JSON.stringify(data, null, 2) + '\n';

    try {
      await writeFile(tmpPath, content, 'utf-8');
      await rename(tmpPath, filePath);
    } catch (err) {
      // Try to clean up tmp file on failure
      try {
        const { unlink } = await import('node:fs/promises');
        await unlink(tmpPath);
      } catch {
        // ignore cleanup errors
      }
      throw err;
    }
  }
}

export const writer = new DebouncedWriter();
