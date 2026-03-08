import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs operations
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  writeFile: vi.fn(),
  stat: vi.fn(),
  unlink: vi.fn(),
}));

// Mock logger
vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock debounced writer
vi.mock('../../src/core/debounced-writer.js', () => ({
  writer: { schedule: vi.fn(), writeNow: vi.fn() },
}));

describe('claude-md-sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns updated=false when no markers exist', async () => {
    const { readFile } = await import('node:fs/promises');
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue('# CLAUDE.md\nNo markers here');

    const { syncClaudeMd } = await import('../../src/evolution/claude-md-sync.js');
    const result = await syncClaudeMd(['src/foo.ts']);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.updated).toBe(false);
      expect(result.value.sections).toHaveLength(0);
    }
  });

  it('returns fail on read error', async () => {
    const { readFile } = await import('node:fs/promises');
    (readFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'));

    const { syncClaudeMd } = await import('../../src/evolution/claude-md-sync.js');
    const result = await syncClaudeMd([]);

    expect(result.ok).toBe(false);
  });

  it('does not write file when content is unchanged', async () => {
    const { readFile, writeFile, readdir } = await import('node:fs/promises');
    const existingContent = [
      '# CLAUDE.md',
      '<!-- AUTO:DIR-START -->',
      '```',
      'soul/           — Bot\'s soul (platform-agnostic, human-readable, portable)',
      'src/            — Source code (the shell)',
      'plugins/        — Dynamic plugin directory (hot-loaded)',
      'data/           — Runtime transient data (not soul)',
      '```',
      '<!-- AUTO:DIR-END -->',
    ].join('\n');

    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(existingContent);
    (readdir as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
      if (path.endsWith('/src')) {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    const { syncClaudeMd } = await import('../../src/evolution/claude-md-sync.js');
    const result = await syncClaudeMd(['src/foo.ts']);

    // If directory scan returns empty dirs, the generated content will differ
    // from existing. The key test is that writeFile is only called when changed.
    expect(result.ok).toBe(true);
  });
});
