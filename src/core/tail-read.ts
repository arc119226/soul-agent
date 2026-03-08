import { open, stat } from 'node:fs/promises';

/**
 * Read the last N lines from a file without loading the entire file.
 * Uses fs.open + seek-from-end to read only the tail portion.
 */
export async function tailReadLines(
  filePath: string,
  lineCount: number,
  maxBytes: number = 65536,
): Promise<string[]> {
  let fileSize: number;
  try {
    const s = await stat(filePath);
    fileSize = s.size;
  } catch {
    return [];
  }
  if (fileSize === 0) return [];

  const readSize = Math.min(fileSize, maxBytes);
  const startPos = Math.max(0, fileSize - readSize);

  const fd = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(readSize);
    await fd.read(buf, 0, readSize, startPos);
    const text = buf.toString('utf-8');
    const lines = text.split('\n').filter(Boolean);
    // If we started mid-file, first line may be truncated — discard it
    if (startPos > 0 && lines.length > 0) lines.shift();
    return lines.slice(-lineCount);
  } finally {
    await fd.close();
  }
}

/**
 * Read the last N lines from a JSONL file and parse each as JSON.
 * Malformed lines are silently skipped.
 */
export async function tailReadJsonl<T>(
  filePath: string,
  lineCount: number,
  maxBytes: number = 65536,
): Promise<T[]> {
  const lines = await tailReadLines(filePath, lineCount, maxBytes);
  const results: T[] = [];
  for (const line of lines) {
    try { results.push(JSON.parse(line) as T); } catch { /* skip malformed */ }
  }
  return results;
}
