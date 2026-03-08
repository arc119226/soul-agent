import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: { TIMEZONE: 'Asia/Taipei' },
}));

vi.mock('../../src/core/timezone.js', () => ({
  getTodayString: vi.fn(() => '2026-01-01'),
  toLocalDateString: vi.fn((s: string) => s.slice(0, 10)),
  getLocalDateParts: vi.fn(() => ({ year: 2026, month: 1, day: 1, hour: 12, minute: 0, dayOfWeek: 3 })),
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    debug: vi.fn().mockResolvedValue(undefined),
    info: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
  },
}));

// Dynamic file content for each test
let fileContents: Record<string, string> = {};

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async (path: string) => {
    const content = fileContents[path as string];
    if (content !== undefined) return content;
    throw new Error('ENOENT');
  }),
}));

import { join } from 'node:path';
import {
  generateProposals,
  formatProposals,
  type Proposal,
} from '../../src/metacognition/proposal-engine.js';
import { getTodayString } from '../../src/core/timezone.js';

const SOUL = join(process.cwd(), 'soul');
const DATA = join(process.cwd(), 'data');

function setFile(path: string, data: unknown): void {
  fileContents[path] = typeof data === 'string' ? data : JSON.stringify(data);
}

function learningPatternsPath(): string {
  return join(SOUL, 'learning-patterns.json');
}

function vitalsPath(): string {
  return join(SOUL, 'vitals.json');
}

function metricsPath(): string {
  const today = getTodayString();
  return join(SOUL, 'metrics', `${today}.json`);
}

function evoMetricsPath(): string {
  return join(DATA, 'evolution-metrics.jsonl');
}

describe('ProposalEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fileContents = {};
  });

  // ── generateProposals ────────────────────────────────────────

  describe('generateProposals', () => {
    it('returns empty array when no data exists', async () => {
      const proposals = await generateProposals();
      expect(proposals).toEqual([]);
    });

    it('detects high failure rate in learning patterns', async () => {
      const now = new Date().toISOString();
      setFile(learningPatternsPath(), {
        version: 1,
        patterns: {
          successes: [
            { category: 'evolution', details: 'ok', timestamp: now },
          ],
          failures: [
            { category: 'evolution', details: 'fail1', timestamp: now },
            { category: 'evolution', details: 'fail2', timestamp: now },
            { category: 'evolution', details: 'fail3', timestamp: now },
          ],
          insights: [],
        },
      });

      const proposals = await generateProposals();
      expect(proposals.length).toBeGreaterThanOrEqual(1);
      const evoProposal = proposals.find(p => p.title.includes('evolution'));
      expect(evoProposal).toBeDefined();
      expect(evoProposal!.severity).toBe('high');
      expect(evoProposal!.source).toBe('learning-patterns');
    });

    it('detects weak reply quality dimensions', async () => {
      const now = new Date().toISOString();
      const entries = Array.from({ length: 10 }, (_, i) => ({
        category: 'reply-quality',
        details: `品質=3.5/5 (good) | 長度=1.0 切題=0.8 情感=0.3 實用=0.9 清晰=0.5`,
        timestamp: now,
      }));

      setFile(learningPatternsPath(), {
        version: 1,
        patterns: { successes: entries, failures: [], insights: [] },
      });

      const proposals = await generateProposals();
      const qualityProposal = proposals.find(p => p.title.includes('品質'));
      expect(qualityProposal).toBeDefined();
      expect(qualityProposal!.evidence).toContain('情感溫度');
    });

    it('detects evolution pipeline failures from metrics', async () => {
      const now = Date.now();
      const lines = [
        JSON.stringify({ timestamp: new Date(now - 3600000).toISOString(), goalId: 'g1', success: false, duration: 5000, failedStep: 'validate', filesChanged: 0 }),
        JSON.stringify({ timestamp: new Date(now - 1800000).toISOString(), goalId: 'g2', success: false, duration: 4000, failedStep: 'validate', filesChanged: 0 }),
        JSON.stringify({ timestamp: new Date(now - 600000).toISOString(), goalId: 'g3', success: true, duration: 8000, filesChanged: 3 }),
      ].join('\n');

      setFile(evoMetricsPath(), lines);

      const proposals = await generateProposals();
      const evoProposal = proposals.find(p => p.source === 'evolution-metrics');
      expect(evoProposal).toBeDefined();
      expect(evoProposal!.evidence).toContain('validate');
    });

    it('detects compromised identity health from vitals', async () => {
      setFile(vitalsPath(), {
        energy_level: 0.8,
        confidence_level: 0.5,
        mood: '警覺',
        identity_health_status: 'compromised',
      });

      const proposals = await generateProposals();
      const vitalProposal = proposals.find(p => p.title.includes('身份'));
      expect(vitalProposal).toBeDefined();
      expect(vitalProposal!.severity).toBe('critical');
      expect(vitalProposal!.score).toBe(90);
    });

    it('detects low confidence from vitals', async () => {
      setFile(vitalsPath(), {
        energy_level: 0.8,
        confidence_level: 0.2,
        mood: '沮喪',
        identity_health_status: 'healthy',
      });

      const proposals = await generateProposals();
      const confProposal = proposals.find(p => p.title.includes('信心'));
      expect(confProposal).toBeDefined();
      expect(confProposal!.severity).toBe('medium');
    });

    it('detects low energy from vitals', async () => {
      setFile(vitalsPath(), {
        energy_level: 0.1,
        confidence_level: 0.5,
        mood: '疲倦',
        identity_health_status: 'healthy',
      });

      const proposals = await generateProposals();
      const energyProposal = proposals.find(p => p.title.includes('精力'));
      expect(energyProposal).toBeDefined();
      expect(energyProposal!.severity).toBe('high');
    });

    it('detects agent task failures from daily metrics', async () => {
      setFile(metricsPath(), {
        messages: { received: 5, sent: 5 },
        agents: { tasksCompleted: 2, tasksFailed: 3 },
        evolution: { attempts: 0, successes: 0, failures: 0 },
        performance: {},
      });

      const proposals = await generateProposals();
      const agentProposal = proposals.find(p => p.source === 'agent-performance');
      expect(agentProposal).toBeDefined();
      expect(agentProposal!.severity).toBe('high');
    });

    it('detects high heap usage from daily metrics', async () => {
      setFile(metricsPath(), {
        messages: { received: 1, sent: 1 },
        agents: { tasksCompleted: 0, tasksFailed: 0 },
        evolution: { attempts: 0, successes: 0, failures: 0 },
        performance: { heapMaxMB: 350 },
      });

      const proposals = await generateProposals();
      const heapProposal = proposals.find(p => p.title.includes('記憶體'));
      expect(heapProposal).toBeDefined();
    });

    it('sorts proposals by score descending', async () => {
      const now = new Date().toISOString();
      setFile(vitalsPath(), {
        energy_level: 0.1,
        confidence_level: 0.2,
        mood: '困難',
        identity_health_status: 'compromised',
      });
      setFile(learningPatternsPath(), {
        version: 1,
        patterns: {
          successes: [],
          failures: [
            { category: 'test', details: 'fail', timestamp: now },
            { category: 'test', details: 'fail', timestamp: now },
            { category: 'test', details: 'fail', timestamp: now },
          ],
          insights: [],
        },
      });

      const proposals = await generateProposals();
      expect(proposals.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < proposals.length; i++) {
        expect(proposals[i]!.score).toBeLessThanOrEqual(proposals[i - 1]!.score);
      }
    });

    it('deduplicates proposals by title', async () => {
      // Same vitals file read twice shouldn't produce duplicate proposals
      setFile(vitalsPath(), {
        energy_level: 0.1,
        confidence_level: 0.2,
        mood: '困',
        identity_health_status: 'compromised',
      });

      const proposals = await generateProposals();
      const titles = proposals.map(p => p.title);
      expect(new Set(titles).size).toBe(titles.length);
    });
  });

  // ── formatProposals ──────────────────────────────────────────

  describe('formatProposals', () => {
    it('returns no-issue message for empty proposals', () => {
      const text = formatProposals([]);
      expect(text).toContain('沒有偵測到');
    });

    it('formats proposals with severity icons', () => {
      const proposals: Proposal[] = [
        {
          title: '測試提案',
          severity: 'critical',
          source: 'vitals',
          evidence: '測試證據',
          suggestion: '測試建議',
          score: 90,
        },
      ];
      const text = formatProposals(proposals);
      expect(text).toContain('🔴');
      expect(text).toContain('測試提案');
      expect(text).toContain('測試證據');
      expect(text).toContain('測試建議');
      expect(text).toContain('資料驅動');
    });

    it('includes all severity levels', () => {
      const proposals: Proposal[] = [
        { title: 'A', severity: 'critical', source: 'vitals', evidence: '', suggestion: '', score: 90 },
        { title: 'B', severity: 'high', source: 'vitals', evidence: '', suggestion: '', score: 70 },
        { title: 'C', severity: 'medium', source: 'vitals', evidence: '', suggestion: '', score: 40 },
        { title: 'D', severity: 'low', source: 'vitals', evidence: '', suggestion: '', score: 10 },
      ];
      const text = formatProposals(proposals);
      expect(text).toContain('🔴');
      expect(text).toContain('🟠');
      expect(text).toContain('🟡');
      expect(text).toContain('🟢');
      expect(text).toContain('共 4 項');
    });
  });

  // ── Edge cases ───────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles malformed learning-patterns gracefully', async () => {
      setFile(learningPatternsPath(), '{ broken json');
      const proposals = await generateProposals();
      // Should not throw, just return empty or partial
      expect(Array.isArray(proposals)).toBe(true);
    });

    it('ignores old failures (> 3 days) in learning patterns', async () => {
      const oldDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
      setFile(learningPatternsPath(), {
        version: 1,
        patterns: {
          successes: [],
          failures: [
            { category: 'evolution', details: 'old fail', timestamp: oldDate },
            { category: 'evolution', details: 'old fail', timestamp: oldDate },
            { category: 'evolution', details: 'old fail', timestamp: oldDate },
          ],
          insights: [],
        },
      });

      const proposals = await generateProposals();
      const evoProposal = proposals.find(p => p.title.includes('evolution'));
      expect(evoProposal).toBeUndefined(); // Old failures should be ignored
    });

    it('does not flag reply quality with < 5 samples', async () => {
      const now = new Date().toISOString();
      setFile(learningPatternsPath(), {
        version: 1,
        patterns: {
          successes: [
            { category: 'reply-quality', details: '品質=2.0/5 (fair) | 長度=0.5 切題=0.3 情感=0.2 實用=0.5 清晰=0.5', timestamp: now },
            { category: 'reply-quality', details: '品質=2.0/5 (fair) | 長度=0.5 切題=0.3 情感=0.2 實用=0.5 清晰=0.5', timestamp: now },
          ],
          failures: [],
          insights: [],
        },
      });

      const proposals = await generateProposals();
      const qualityProposal = proposals.find(p => p.title.includes('品質'));
      expect(qualityProposal).toBeUndefined(); // Not enough samples
    });
  });
});
