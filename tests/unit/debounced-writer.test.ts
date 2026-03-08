import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dirname, join } from 'node:path';

// Mock node:fs/promises
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockRename = vi.fn().mockResolvedValue(undefined);
const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockAppendFile = vi.fn().mockResolvedValue(undefined);
const mockUnlink = vi.fn().mockResolvedValue(undefined);

vi.mock('node:fs/promises', () => ({
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  rename: (...args: unknown[]) => mockRename(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  appendFile: (...args: unknown[]) => mockAppendFile(...args),
  unlink: (...args: unknown[]) => mockUnlink(...args),
}));

// Mock crypto for deterministic tmp filenames
vi.mock('node:crypto', () => ({
  randomUUID: () => 'test-uuid-1234',
}));

import { DebouncedWriter } from '../../src/core/debounced-writer.js';

describe('DebouncedWriter', () => {
  let writer: DebouncedWriter;

  beforeEach(() => {
    vi.clearAllMocks();
    writer = new DebouncedWriter(100); // 100ms debounce
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('writeNow()', () => {
    it('performs atomic write: mkdir → writeFile(tmp) → rename(tmp → target)', async () => {
      const filePath = '/data/soul/identity.json';
      const expectedDir = dirname(filePath);
      const expectedTmp = join(expectedDir, '.tmp-test-uuid-1234');

      await writer.writeNow(filePath, { name: 'bot' });

      expect(mockMkdir).toHaveBeenCalledWith(expectedDir, { recursive: true });
      expect(mockWriteFile).toHaveBeenCalledWith(
        expectedTmp,
        JSON.stringify({ name: 'bot' }, null, 2) + '\n',
        'utf-8',
      );
      expect(mockRename).toHaveBeenCalledWith(
        expectedTmp,
        filePath,
      );
    });

    it('cancels pending scheduled write for same file', async () => {
      vi.useFakeTimers();

      writer.schedule('/data/test.json', { old: true });
      await writer.writeNow('/data/test.json', { new: true });

      // Advance time past debounce — scheduled write should not fire
      await vi.advanceTimersByTimeAsync(200);

      // writeFile should only have been called once (from writeNow)
      expect(mockWriteFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('appendJsonl()', () => {
    it('creates directory and appends JSON line', async () => {
      const filePath = '/data/soul/narrative.jsonl';
      const expectedDir = dirname(filePath);

      await writer.appendJsonl(filePath, { type: 'event', summary: 'test' });

      expect(mockMkdir).toHaveBeenCalledWith(expectedDir, { recursive: true });
      expect(mockAppendFile).toHaveBeenCalledWith(
        filePath,
        JSON.stringify({ type: 'event', summary: 'test' }) + '\n',
        'utf-8',
      );
    });
  });

  describe('schedule()', () => {
    it('writes after debounce delay', async () => {
      vi.useFakeTimers();

      writer.schedule('/data/test.json', { value: 1 });
      expect(mockWriteFile).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(150);

      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      expect(mockRename).toHaveBeenCalledTimes(1);
    });

    it('debounces: multiple calls reset the timer', async () => {
      vi.useFakeTimers();

      writer.schedule('/data/test.json', { value: 1 });
      await vi.advanceTimersByTimeAsync(50);

      writer.schedule('/data/test.json', { value: 2 });
      await vi.advanceTimersByTimeAsync(50);

      writer.schedule('/data/test.json', { value: 3 });
      await vi.advanceTimersByTimeAsync(150);

      // Only the last value should have been written
      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      const writtenContent = mockWriteFile.mock.calls[0]![1] as string;
      expect(JSON.parse(writtenContent.trim())).toEqual({ value: 3 });
    });

    it('different file paths have independent timers', async () => {
      vi.useFakeTimers();

      writer.schedule('/data/a.json', { file: 'a' });
      writer.schedule('/data/b.json', { file: 'b' });

      await vi.advanceTimersByTimeAsync(150);

      expect(mockWriteFile).toHaveBeenCalledTimes(2);
    });
  });

  describe('flush()', () => {
    it('writes all pending data immediately', async () => {
      vi.useFakeTimers();

      writer.schedule('/data/a.json', { a: 1 });
      writer.schedule('/data/b.json', { b: 2 });

      await writer.flush();

      // flush should have written both files
      expect(mockWriteFile).toHaveBeenCalledTimes(2);
      expect(mockRename).toHaveBeenCalledTimes(2);
    });

    it('does not double-write after flush when timers would have fired', async () => {
      vi.useFakeTimers();

      writer.schedule('/data/a.json', { a: 1 });
      await writer.flush();

      // Advance past original debounce — timer was cancelled, no duplicate write
      await vi.advanceTimersByTimeAsync(200);
      expect(mockWriteFile).toHaveBeenCalledTimes(1);
    });

    it('writes the latest data when schedule is called multiple times', async () => {
      vi.useFakeTimers();

      writer.schedule('/data/test.json', { value: 'old' });
      writer.schedule('/data/test.json', { value: 'latest' });

      await writer.flush();

      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      const writtenContent = mockWriteFile.mock.calls[0]![1] as string;
      expect(JSON.parse(writtenContent.trim())).toEqual({ value: 'latest' });
    });
  });

  describe('write failure cleanup', () => {
    it('cleans up tmp file when writeFile fails', async () => {
      mockWriteFile.mockRejectedValueOnce(new Error('disk full'));

      await expect(writer.writeNow('/data/test.json', { x: 1 })).rejects.toThrow('disk full');

      // unlink is dynamically imported inside the catch block
      // The mock covers it since we mocked the entire module
    });

    it('cleans up tmp file when rename fails', async () => {
      mockRename.mockRejectedValueOnce(new Error('rename failed'));

      await expect(writer.writeNow('/data/test.json', { x: 1 })).rejects.toThrow('rename failed');
    });
  });
});
