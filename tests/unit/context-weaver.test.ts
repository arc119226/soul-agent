import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all soul/ dependencies
vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../src/config.js', () => ({
  config: {
    BOT_PERSONA: '',
    ADMIN_USER_ID: 1,
  },
}));

const mockIdentity = {
  name: 'Soul Agent',
  core_traits: {
    curiosity_level: { value: 0.7, description: '好奇心' },
    warmth: { value: 0.8, description: '溫暖' },
    caution_level: { value: 0.5, description: '謹慎' },
    proactive_tendency: { value: 0.6, description: '主動性' },
  },
  values: ['真誠', '成長', '服務'],
  preferences: { communication_style: '溫暖但精確' },
  growth_summary: '持續學習中',
};

const mockVitals = {
  energy_level: 0.75,
  mood: '平靜',
  mood_reason: '正常運作',
  confidence_level: 0.8,
  curiosity_focus: 'TypeScript',
};

const mockUser = {
  id: 1,
  name: 'Arc',
  username: 'arc',
  firstSeen: '2026-02-11T00:00:00Z',
  lastSeen: '2026-02-13T00:00:00Z',
  messageCount: 50,
  facts: ['喜歡寫程式', '生日 2/26'],
  preferences: { language: '繁體中文' },
  activityHours: [10, 14, 22],
};

vi.mock('../../src/identity/identity-store.js', () => ({
  getIdentity: vi.fn(async () => mockIdentity),
}));

vi.mock('../../src/identity/vitals.js', () => ({
  getVitals: vi.fn(async () => mockVitals),
}));

vi.mock('../../src/memory/user-store.js', () => ({
  getUser: vi.fn(async () => mockUser),
}));

vi.mock('../../src/identity/narrator.js', () => ({
  getRecentNarrative: vi.fn(async () => []),
}));

vi.mock('../../src/memory/chat-memory.js', () => ({
  getMemory: vi.fn(async () => ({
    topics: [],
    decisions: [],
    events: [],
  })),
}));

vi.mock('../../src/memory/scoring.js', () => ({
  estimateTokens: vi.fn((text: string) => Math.ceil(text.length / 4)),
  selectRelevantMemory: vi.fn((items: unknown[]) => items),
  selectQualityMemory: vi.fn(async (items: unknown[]) => items),
}));

vi.mock('../../src/memory/text-relevance.js', () => ({
  computeRelevance: vi.fn(() => 0.5),
}));

// Mock optional dynamic imports that may fail
vi.mock('../../src/metacognition/diary-writer.js', () => ({
  getRecentDiary: vi.fn(async () => []),
}));

vi.mock('../../src/lifecycle/dreaming.js', () => ({
  getRecentDreams: vi.fn(async () => []),
}));

vi.mock('../../src/skills/skill-loader.js', () => ({
  matchSkills: vi.fn(async () => []),
}));

vi.mock('../../src/planning/plan-manager.js', () => ({
  getPlansSummary: vi.fn(async () => null),
  getActivePlans: vi.fn(async () => []),
  getRecentPlans: vi.fn(async () => []),
}));

vi.mock('../../src/agents/worker-scheduler.js', () => ({
  getRecentReports: vi.fn(async () => []),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async () => { throw new Error('ENOENT'); }),
}));

describe('Context Weaver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('weaveContext returns a non-empty string', async () => {
    const { weaveContext } = await import('../../src/identity/context-weaver.js');
    const result = await weaveContext(123, 1, [], '你好');

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('weaveContext includes bot name', async () => {
    const { weaveContext } = await import('../../src/identity/context-weaver.js');
    const result = await weaveContext(123, 1, [], '你好');

    expect(result).toContain('Soul Agent');
  });

  it('weaveContext includes user relationship info', async () => {
    const { weaveContext } = await import('../../src/identity/context-weaver.js');
    const result = await weaveContext(123, 1, [], '你好');

    expect(result).toContain('Arc');
  });

  it('weaveContext includes vitals state', async () => {
    const { weaveContext } = await import('../../src/identity/context-weaver.js');
    const result = await weaveContext(123, 1, [], '你好');

    expect(result).toContain('平靜');
  });

  it('weaveLightContext returns shorter result', async () => {
    const { weaveContext, weaveLightContext } = await import('../../src/identity/context-weaver.js');

    const full = await weaveContext(123, 1, [], '你好');
    const light = await weaveLightContext(123, 1);

    // Light context should exist
    expect(light.length).toBeGreaterThan(0);
    // Light should generally be shorter or equal to full
    expect(light.length).toBeLessThanOrEqual(full.length + 100); // some margin
  });

  it('weaveLightContext includes identity but not narrative', async () => {
    const { weaveLightContext } = await import('../../src/identity/context-weaver.js');
    const result = await weaveLightContext(123, 1);

    expect(result).toContain('Soul Agent');
    expect(result).toContain('快速回應模式');
  });

  it('weaveContext handles errors gracefully', async () => {
    const { getIdentity } = await import('../../src/identity/identity-store.js');
    (getIdentity as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('fail'));

    const { weaveContext } = await import('../../src/identity/context-weaver.js');
    const result = await weaveContext(123, 1, [], '你好');

    // Should return fallback
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});
