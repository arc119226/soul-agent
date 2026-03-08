import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: { TIMEZONE: 'Asia/Taipei' },
}));

vi.mock('../../src/core/timezone.js', () => {
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return {
    getTodayString: vi.fn((now?: Date) => fmt(now ?? new Date())),
    toLocalDateString: vi.fn((iso: string) => fmt(new Date(iso))),
    getLocalDateParts: vi.fn((now?: Date) => {
      const d = now ?? new Date();
      return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes(), dayOfWeek: d.getDay() };
    }),
  };
});

// Mock all dependencies
vi.mock('../../src/core/debounced-writer.js', () => ({
  writer: {
    appendJsonl: vi.fn(async () => {}),
    schedule: vi.fn(),
  },
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockNarrativeEntries = [
  {
    timestamp: new Date().toISOString(),
    type: 'interaction',
    summary: '與主人討論了 TypeScript',
    significance: 3,
    emotion: '喜悅',
    related_to: 'typescript',
  },
  {
    timestamp: new Date().toISOString(),
    type: 'evolution',
    summary: '成功進化了新功能',
    significance: 4,
    emotion: '成長',
    related_to: 'evolution',
  },
];

vi.mock('../../src/identity/narrator.js', () => ({
  getRecentNarrative: vi.fn(async () => mockNarrativeEntries),
}));

vi.mock('../../src/identity/vitals.js', () => ({
  getVitals: vi.fn(async () => ({
    energy_level: 0.7,
    mood: '平靜',
    mood_reason: '',
    confidence_level: 0.6,
    curiosity_focus: null,
  })),
}));

vi.mock('../../src/identity/identity-store.js', () => ({
  getIdentity: vi.fn(async () => ({
    name: 'Soul Agent',
    core_traits: {
      curiosity_level: { value: 0.7, description: '' },
      warmth: { value: 0.8, description: '' },
      caution_level: { value: 0.5, description: '' },
      proactive_tendency: { value: 0.6, description: '' },
    },
    values: [],
    preferences: {},
    growth_summary: '',
  })),
}));

// Mock optional dynamic imports
vi.mock('../../src/metacognition/learning-tracker.js', () => ({
  getPatterns: vi.fn(async () => ({
    successes: [{ category: 'test', summary: 's', timestamp: new Date().toISOString() }],
    failures: [],
    insights: ['最近學到了很多'],
  })),
  getPatternsByCategory: vi.fn(async () => ({
    successes: [],
    failures: [],
    successRate: 1,
  })),
}));

vi.mock('../../src/metacognition/curiosity.js', () => ({
  getCuriosityTopics: vi.fn(async () => []),
}));

vi.mock('../../src/agents/config/agent-tuner.js', () => ({
  generatePerformanceSummary: vi.fn(async () => []),
}));

vi.mock('../../src/planning/plan-manager.js', () => ({
  getActivePlans: vi.fn(async () => []),
  getRecentPlans: vi.fn(async () => []),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async () => { throw new Error('ENOENT'); }),
}));

describe('Reflection Engine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('triggerReflection returns a valid ReflectionEntry', async () => {
    const { triggerReflection } = await import('../../src/metacognition/reflection.js');
    const entry = await triggerReflection('triggered');

    expect(entry).toHaveProperty('timestamp');
    expect(entry).toHaveProperty('type', 'triggered');
    expect(entry).toHaveProperty('insights');
    expect(entry).toHaveProperty('mood_assessment');
    expect(entry).toHaveProperty('growth_notes');
    expect(entry).toHaveProperty('interaction_count');
    expect(entry).toHaveProperty('topics_discussed');
    expect(Array.isArray(entry.insights)).toBe(true);
  });

  it('triggerReflection generates insights from interactions', async () => {
    const { triggerReflection } = await import('../../src/metacognition/reflection.js');
    const entry = await triggerReflection('daily');

    // Should have insights about today's interactions
    expect(entry.insights.length).toBeGreaterThan(0);
  });

  it('triggerReflection produces mood assessment', async () => {
    const { triggerReflection } = await import('../../src/metacognition/reflection.js');
    const entry = await triggerReflection();

    expect(typeof entry.mood_assessment).toBe('string');
    expect(entry.mood_assessment.length).toBeGreaterThan(0);
  });

  it('triggerReflection produces growth notes', async () => {
    const { triggerReflection } = await import('../../src/metacognition/reflection.js');
    const entry = await triggerReflection();

    expect(typeof entry.growth_notes).toBe('string');
    expect(entry.growth_notes.length).toBeGreaterThan(0);
  });

  it('triggerReflection persists to JSONL', async () => {
    const { writer } = await import('../../src/core/debounced-writer.js');
    const { triggerReflection } = await import('../../src/metacognition/reflection.js');

    await triggerReflection();

    expect(writer.appendJsonl).toHaveBeenCalledWith(
      expect.stringContaining('reflections.jsonl'),
      expect.objectContaining({ type: 'triggered' }),
    );
  });

  it('triggerReflection collects topics from narrative', async () => {
    const { triggerReflection } = await import('../../src/metacognition/reflection.js');
    const entry = await triggerReflection();

    // mockNarrativeEntries have related_to: 'typescript' and 'evolution'
    expect(entry.topics_discussed).toContain('typescript');
    expect(entry.topics_discussed).toContain('evolution');
  });

  it('triggerReflection handles empty narrative gracefully', async () => {
    const { getRecentNarrative } = await import('../../src/identity/narrator.js');
    (getRecentNarrative as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    const { triggerReflection } = await import('../../src/metacognition/reflection.js');
    const entry = await triggerReflection();

    // Should still produce a valid entry
    expect(entry.interaction_count).toBe(0);
    expect(entry.insights.length).toBeGreaterThan(0); // at least default insight
  });

  it('getRecentReflections returns empty array when file does not exist', async () => {
    const { getRecentReflections } = await import('../../src/metacognition/reflection.js');
    const entries = await getRecentReflections(5);
    expect(entries).toEqual([]);
  });
});
