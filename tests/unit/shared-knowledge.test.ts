import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';

// ── Mocks (before imports) ──────────────────────────────────────────

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn().mockResolvedValue(undefined),
    debug: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/core/debounced-writer.js', () => ({
  writer: {
    appendJsonl: vi.fn().mockResolvedValue(undefined),
  },
}));

let fileContents: Record<string, string> = {};
const mockWriteFile = vi.fn().mockResolvedValue(undefined);

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async (path: string) => {
    const content = fileContents[path];
    if (content !== undefined) return content;
    throw new Error('ENOENT');
  }),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
}));

import { depositKnowledge, queryKnowledge, compactKnowledge } from '../../src/agents/knowledge/shared-knowledge.js';
import { writer } from '../../src/core/debounced-writer.js';

const KNOWLEDGE_PATH = join(process.cwd(), 'soul', 'agent-tasks', 'shared-knowledge.jsonl');

// ── Helpers ─────────────────────────────────────────────────────────

function makeEntry(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'e1',
    agentName: 'explorer',
    taskId: 't1',
    timestamp: new Date().toISOString(),
    summary: 'AI 安全漏洞發現 important',
    keywords: ['ai', '安全', 'security'],
    importance: 3,
    category: 'finding',
    ttlHours: 72,
    ...overrides,
  });
}

function expiredEntry(overrides: Record<string, unknown> = {}): string {
  return makeEntry({
    id: 'expired-1',
    timestamp: new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString(), // 100h ago
    ttlHours: 72,
    ...overrides,
  });
}

// ── Tests ───────────────────────────────────────────────────────────

describe('SharedKnowledge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fileContents = {};
  });

  describe('depositKnowledge()', () => {
    it('appends a knowledge entry when result has meaningful content', async () => {
      await depositKnowledge(
        'explorer', 'task-1',
        '## 發現\n\n重要發現：AI 安全漏洞 important critical vulnerability discovery analysis',
        'AI security audit prompt',
      );
      expect(vi.mocked(writer.appendJsonl)).toHaveBeenCalledOnce();
      const [path, entry] = vi.mocked(writer.appendJsonl).mock.calls[0]!;
      expect(path).toBe(KNOWLEDGE_PATH);
      expect((entry as { agentName: string }).agentName).toBe('explorer');
      expect((entry as { keywords: string[] }).keywords.length).toBeGreaterThan(0);
    });

    it('does not deposit when result is too short to extract keywords', async () => {
      await depositKnowledge('explorer', 'task-2', 'ok', '');
      expect(vi.mocked(writer.appendJsonl)).not.toHaveBeenCalled();
    });
  });

  describe('queryKnowledge()', () => {
    it('returns empty string when no file exists', async () => {
      const result = await queryKnowledge('blog-writer', 'AI security');
      expect(result).toBe('');
    });

    it('returns matching entries with formatted header', async () => {
      fileContents[KNOWLEDGE_PATH] = makeEntry({ agentName: 'explorer' }) + '\n';
      const result = await queryKnowledge('blog-writer', 'AI security 安全');
      expect(result).toContain('其他代理人的近期相關發現');
      expect(result).toContain('explorer');
    });

    it('excludes self-agent entries', async () => {
      fileContents[KNOWLEDGE_PATH] = makeEntry({ agentName: 'blog-writer' }) + '\n';
      const result = await queryKnowledge('blog-writer', 'AI security 安全');
      expect(result).toBe('');
    });

    it('filters expired entries by TTL', async () => {
      fileContents[KNOWLEDGE_PATH] = expiredEntry() + '\n';
      const result = await queryKnowledge('scanner', 'AI security 安全');
      expect(result).toBe('');
    });
  });

  describe('compactKnowledge()', () => {
    it('returns 0 when file does not exist', async () => {
      const removed = await compactKnowledge();
      expect(removed).toBe(0);
    });

    it('removes expired entries and rewrites file', async () => {
      const expired = expiredEntry({ id: 'old' });
      const valid = makeEntry({ id: 'new' });
      fileContents[KNOWLEDGE_PATH] = [expired, valid].join('\n') + '\n';
      const removed = await compactKnowledge();
      expect(removed).toBe(1);
      expect(mockWriteFile).toHaveBeenCalledOnce();
      // Verify rewritten content contains only valid entry
      const written = mockWriteFile.mock.calls[0]![1] as string;
      expect(written).toContain('"new"');
      expect(written).not.toContain('"old"');
    });

    it('returns 0 when all entries are valid (no rewrite)', async () => {
      fileContents[KNOWLEDGE_PATH] = makeEntry() + '\n';
      const removed = await compactKnowledge();
      expect(removed).toBe(0);
      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });
});
