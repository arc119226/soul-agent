/**
 * Soul I/O abstraction layer.
 *
 * Centralizes all soul/ directory path construction and file access
 * behind a small, consistent API. Uses DebouncedWriter for atomic
 * JSON writes (tmp -> rename).
 *
 * Usage:
 *   import { getSoulPath, readSoulJson, writeSoulJson } from '../core/soul-io.js';
 *   const vitals = await readSoulJson<Vitals>('vitals.json');
 *   await writeSoulJson('vitals.json', vitals);
 */

import { readFile, access, readdir, mkdir, writeFile as fsWriteFile, rename as fsRename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writer } from './debounced-writer.js';

// ── Path construction ────────────────────────────────────────────────

/** Absolute path to the soul/ directory. */
export const SOUL_DIR = join(process.cwd(), 'soul');

/** Build an absolute path under soul/. Accepts variadic segments. */
export function getSoulPath(...segments: string[]): string {
  return join(SOUL_DIR, ...segments);
}

// ── Read ─────────────────────────────────────────────────────────────

/** Read a UTF-8 text file from soul/. Throws if not found. */
export async function readSoulFile(...segments: string[]): Promise<string> {
  return readFile(getSoulPath(...segments), 'utf-8');
}

/** Read and parse a JSON file from soul/. Throws if not found or malformed. */
export async function readSoulJson<T = unknown>(...segments: string[]): Promise<T> {
  const raw = await readSoulFile(...segments);
  return JSON.parse(raw) as T;
}

// ── Write ────────────────────────────────────────────────────────────

/**
 * Atomic-write a JSON object to soul/ (immediate, not debounced).
 * Uses DebouncedWriter.writeNow() for crash-safe tmp->rename.
 */
export async function writeSoulJson(relativePath: string, data: unknown): Promise<void> {
  await writer.writeNow(getSoulPath(relativePath), data);
}

/**
 * Schedule a debounced JSON write to soul/.
 * Data is buffered and written after the debounce delay (1s default).
 * Use for high-frequency writes (e.g. vitals, metrics).
 */
export function scheduleSoulJson(relativePath: string, data: unknown): void {
  writer.schedule(getSoulPath(relativePath), data);
}

/**
 * Atomic-write a raw text file to soul/.
 * Creates parent directories as needed. Uses tmp->rename for crash safety.
 */
export async function writeSoulText(relativePath: string, content: string): Promise<void> {
  const filePath = getSoulPath(relativePath);
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-${randomUUID()}`);
  try {
    await fsWriteFile(tmpPath, content, 'utf-8');
    await fsRename(tmpPath, filePath);
  } catch (err) {
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(tmpPath);
    } catch { /* ignore cleanup errors */ }
    throw err;
  }
}

/** Append a JSON entry as a line to a JSONL file under soul/. */
export async function appendSoulJsonl(relativePath: string, entry: unknown): Promise<void> {
  await writer.appendJsonl(getSoulPath(relativePath), entry);
}

// ── Check / List ─────────────────────────────────────────────────────

/** Check if a path exists under soul/. */
export async function soulExists(...segments: string[]): Promise<boolean> {
  try {
    await access(getSoulPath(...segments));
    return true;
  } catch {
    return false;
  }
}

/** List entries in a soul/ subdirectory. Returns filenames (not full paths). */
export async function listSoulDir(...segments: string[]): Promise<string[]> {
  return readdir(getSoulPath(...segments));
}
