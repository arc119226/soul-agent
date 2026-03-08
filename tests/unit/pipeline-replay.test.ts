import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';

// ── Mocks (before imports) ──────────────────────────────────────────

let fileContents: Record<string, string> = {};

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async (path: string) => {
    const content = fileContents[path];
    if (content !== undefined) return content;
    throw new Error('ENOENT');
  }),
}));

import { replayPipeline } from '../../src/agents/pipeline-replay.js';

const PIPELINES_DIR = join(process.cwd(), 'soul', 'agent-tasks', 'pipelines');

// ── Helpers ─────────────────────────────────────────────────────────

function makePipelineRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-abc',
    teamName: 'test-team',
    prompt: 'Do something interesting',
    status: 'completed',
    createdAt: '2026-02-21T10:00:00Z',
    completedAt: '2026-02-21T10:05:00Z',
    stages: {},
    currentLayerIndex: 0,
    totalCostUsd: 0.0050,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('PipelineReplay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fileContents = {};
  });

  it('returns "Pipeline not found" for missing pipeline', async () => {
    const result = await replayPipeline('nonexistent-id');
    expect(result).toContain('Pipeline not found');
    expect(result).toContain('nonexistent-id');
  });

  it('formats a minimal pipeline into Markdown timeline', async () => {
    const run = makePipelineRun();
    fileContents[join(PIPELINES_DIR, 'run-abc.json')] = JSON.stringify(run);

    const result = await replayPipeline('run-abc');
    expect(result).toContain('# Pipeline Replay: run-abc');
    expect(result).toContain('test-team');
    expect(result).toContain('completed');
    expect(result).toContain('$0.0050');
    expect(result).toContain('## Timeline');
  });

  it('includes stage events in timeline', async () => {
    const run = makePipelineRun({
      id: 'run-xyz',
      stages: {
        research: {
          stageId: 'research',
          agentName: 'explorer',
          status: 'completed',
          taskId: 'task-1',
          output: 'Found interesting things',
          error: null,
          startedAt: '2026-02-21T10:00:30Z',
          completedAt: '2026-02-21T10:02:00Z',
        },
      },
    });
    fileContents[join(PIPELINES_DIR, 'run-xyz.json')] = JSON.stringify(run);

    const result = await replayPipeline('run-xyz');
    expect(result).toContain('Stage Started: research');
    expect(result).toContain('Stage completed: research');
    expect(result).toContain('explorer');
  });

  it('handles pipeline with no stages', async () => {
    const run = makePipelineRun({
      id: 'run-empty',
      status: 'running',
      completedAt: null,
    });
    fileContents[join(PIPELINES_DIR, 'run-empty.json')] = JSON.stringify(run);

    const result = await replayPipeline('run-empty');
    expect(result).toContain('Pipeline Replay: run-empty');
    expect(result).toContain('## Timeline');
    // Should have Pipeline Started event
    expect(result).toContain('[P]');
  });

  it('includes failed stage error detail', async () => {
    const run = makePipelineRun({
      id: 'run-fail',
      stages: {
        analyze: {
          stageId: 'analyze',
          agentName: 'analyst',
          status: 'failed',
          taskId: 'task-2',
          output: null,
          error: 'Budget exceeded during analysis',
          startedAt: '2026-02-21T10:00:00Z',
          completedAt: '2026-02-21T10:01:00Z',
        },
      },
    });
    fileContents[join(PIPELINES_DIR, 'run-fail.json')] = JSON.stringify(run);

    const result = await replayPipeline('run-fail');
    expect(result).toContain('Error: Budget exceeded');
  });
});
