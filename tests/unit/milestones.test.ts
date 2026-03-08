import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('../../src/core/debounced-writer.js', () => ({
  writer: {
    schedule: vi.fn(),
  },
}));

vi.mock('../../src/core/event-bus.js', () => ({
  eventBus: {
    emit: vi.fn(async () => {}),
  },
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../../src/identity/narrator.js', () => ({
  appendNarrative: vi.fn(async () => {}),
}));

// Mock fs
let mockMilestonesContent: string | null = null;

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async () => {
    if (mockMilestonesContent === null) throw new Error('ENOENT');
    return mockMilestonesContent;
  }),
}));

// Mock the dynamic imports that collectStats uses
vi.mock('../../src/memory/user-store.js', () => ({
  getAllUsers: vi.fn(async () => ({})),
}));

vi.mock('../../src/evolution/changelog.js', () => ({
  getRecentChanges: vi.fn(async () => []),
}));

vi.mock('../../src/plugins/plugin-loader.js', () => ({
  getLoadedPlugins: vi.fn(() => new Map()),
}));

describe('Milestones', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockMilestonesContent = null;
    vi.resetModules();
  });

  async function loadModule() {
    return import('../../src/identity/milestones.js');
  }

  it('getMilestones returns empty array when file does not exist', async () => {
    const mod = await loadModule();
    mod.resetCache();

    const milestones = await mod.getMilestones();
    expect(milestones).toEqual([]);
  });

  it('getMilestones returns stored milestones', async () => {
    mockMilestonesContent = JSON.stringify({
      version: 1,
      milestones: [
        { type: 'first_conversation', description: '完成了第一次對話', timestamp: '2026-02-11T00:00:00Z', significance: 5 },
      ],
    });

    const mod = await loadModule();
    mod.resetCache();

    const milestones = await mod.getMilestones();
    expect(milestones).toHaveLength(1);
    expect(milestones[0]!.type).toBe('first_conversation');
  });

  it('checkMilestones unlocks first_conversation with 1 interaction', async () => {
    const mod = await loadModule();
    mod.resetCache();

    const newMilestones = await mod.checkMilestones({
      totalInteractions: 1,
      totalEvolutions: 0,
      totalUsers: 1,
      uptimeDays: 0,
      firstBootTime: null,
    });

    expect(newMilestones.length).toBeGreaterThan(0);
    expect(newMilestones.some((m) => m.type === 'first_conversation')).toBe(true);
  });

  it('checkMilestones does not re-unlock existing milestones', async () => {
    mockMilestonesContent = JSON.stringify({
      version: 1,
      milestones: [
        { type: 'first_conversation', description: '完成了第一次對話', timestamp: '2026-02-11T00:00:00Z', significance: 5 },
      ],
    });

    const mod = await loadModule();
    mod.resetCache();

    const newMilestones = await mod.checkMilestones({
      totalInteractions: 1,
      totalEvolutions: 0,
      totalUsers: 1,
      uptimeDays: 0,
      firstBootTime: null,
    });

    expect(newMilestones.find((m) => m.type === 'first_conversation')).toBeUndefined();
  });

  it('checkMilestones unlocks multiple milestones at once', async () => {
    const mod = await loadModule();
    mod.resetCache();

    const newMilestones = await mod.checkMilestones({
      totalInteractions: 100,
      totalEvolutions: 5,
      totalUsers: 2,
      uptimeDays: 7,
      firstBootTime: '2026-02-01T00:00:00Z',
    });

    const types = newMilestones.map((m) => m.type);
    expect(types).toContain('first_conversation');
    expect(types).toContain('interactions_10');
    expect(types).toContain('interactions_100');
    expect(types).toContain('first_evolution');
    expect(types).toContain('evolutions_5');
    expect(types).toContain('first_multi_user');
    expect(types).toContain('uptime_7days');
  });

  it('checkMilestones emits milestone:reached event', async () => {
    const mod = await loadModule();
    mod.resetCache();
    const { eventBus } = await import('../../src/core/event-bus.js');

    await mod.checkMilestones({
      totalInteractions: 1,
      totalEvolutions: 0,
      totalUsers: 0,
      uptimeDays: 0,
      firstBootTime: null,
    });

    expect(eventBus.emit).toHaveBeenCalledWith(
      'milestone:reached',
      expect.objectContaining({ type: 'first_conversation' }),
    );
  });

  it('checkMilestones returns empty array when no new milestones', async () => {
    const mod = await loadModule();
    mod.resetCache();

    const newMilestones = await mod.checkMilestones({
      totalInteractions: 0,
      totalEvolutions: 0,
      totalUsers: 0,
      uptimeDays: 0,
      firstBootTime: null,
    });

    expect(newMilestones).toEqual([]);
  });

  it('checkMilestones detects special achievements', async () => {
    const mod = await loadModule();
    mod.resetCache();

    const newMilestones = await mod.checkMilestones({
      totalInteractions: 1,
      totalEvolutions: 0,
      totalUsers: 1,
      uptimeDays: 0,
      firstBootTime: null,
      hasNightInteraction: true,
      hasEarlyInteraction: true,
      maxDailyMessages: 25,
      pluginCount: 1,
      consecutiveDays: 7,
    });

    const types = newMilestones.map((m) => m.type);
    expect(types).toContain('night_owl');
    expect(types).toContain('early_bird');
    expect(types).toContain('chatterbox');
    expect(types).toContain('plugin_creator');
    expect(types).toContain('week_streak');
  });
});
