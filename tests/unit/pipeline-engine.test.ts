import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before imports
vi.mock('../../src/core/event-bus.js', () => ({
  eventBus: {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
    debug: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/core/debounced-writer.js', () => ({
  writer: {
    writeNow: vi.fn().mockResolvedValue(undefined),
    appendJsonl: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('not found')),
  mkdir: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/agents/worker-scheduler.js', () => ({
  enqueueTask: vi.fn().mockResolvedValue('mock-task-id'),
}));

// Mock team-config to return test templates
vi.mock('../../src/agents/config/team-config.js', async () => {
  const actual = await vi.importActual('../../src/agents/config/team-config.js');
  return {
    ...actual,
    loadTeamTemplate: vi.fn(),
  };
});

import {
  startPipeline,
  abortPipeline,
  getPipelineRun,
  getActivePipelines,
  registerPipelineListener,
  parseHandoff,
  stripHandoff,
} from '../../src/agents/pipeline-engine.js';
import { loadTeamTemplate } from '../../src/agents/config/team-config.js';
import type { TeamTemplate } from '../../src/agents/config/team-config.js';
import { eventBus } from '../../src/core/event-bus.js';
import { enqueueTask } from '../../src/agents/worker-scheduler.js';

const mockTemplate: TeamTemplate = {
  name: 'test-pipeline',
  description: 'test',
  version: 1,
  members: [
    { agentName: 'explorer', teamRole: 'researcher', goal: 'Research topics' },
    { agentName: 'blog-writer', teamRole: 'writer', goal: 'Write articles' },
  ],
  workflow: {
    mode: 'sequential',
    stages: [
      { id: 'research', agentName: 'explorer', inputFilter: 'passthrough' },
      { id: 'write', agentName: 'blog-writer', inputFrom: ['research'], inputFilter: 'blog-source-material' },
    ],
  },
  budget: { maxTotalCostUsd: 1.0 },
  governance: {
    requireReviewStage: false,
    minConfidence: 0.6,
    escalateOnFailure: 'abort',
  },
};

describe('Pipeline Engine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadTeamTemplate).mockResolvedValue(mockTemplate);
  });

  afterEach(() => {
    // Clean up active pipelines
    for (const p of getActivePipelines()) {
      abortPipeline(p.id, 'test cleanup');
    }
  });

  describe('startPipeline()', () => {
    it('creates a pipeline run with correct structure', async () => {
      const run = await startPipeline('test-pipeline', 'Write about AI');
      expect(run).not.toBeNull();
      expect(run!.teamName).toBe('test-pipeline');
      expect(run!.prompt).toBe('Write about AI');
      expect(run!.status).toBe('running');
      expect(Object.keys(run!.stages)).toHaveLength(2);
      expect(run!.stages['research']!.status).toBe('running'); // first stage dispatched
      expect(run!.stages['write']!.status).toBe('pending');    // waiting for research
    });

    it('dispatches first stage via enqueueTask', async () => {
      await startPipeline('test-pipeline', 'Write about AI');
      expect(enqueueTask).toHaveBeenCalledWith('explorer', expect.any(String), 7);
    });

    it('emits team:pipeline:started event', async () => {
      await startPipeline('test-pipeline', 'Write about AI');
      expect(eventBus.emit).toHaveBeenCalledWith('team:pipeline:started', expect.objectContaining({
        teamName: 'test-pipeline',
      }));
    });

    it('returns null for unknown team', async () => {
      vi.mocked(loadTeamTemplate).mockResolvedValue(null);
      const run = await startPipeline('nonexistent', 'test');
      expect(run).toBeNull();
    });
  });

  describe('abortPipeline()', () => {
    it('aborts a running pipeline', async () => {
      const run = await startPipeline('test-pipeline', 'test');
      expect(run).not.toBeNull();

      const aborted = await abortPipeline(run!.id, 'test abort');
      expect(aborted).toBe(true);
    });

    it('emits team:pipeline:aborted event', async () => {
      const run = await startPipeline('test-pipeline', 'test');
      await abortPipeline(run!.id, 'test abort');
      expect(eventBus.emit).toHaveBeenCalledWith('team:pipeline:aborted', expect.objectContaining({
        runId: run!.id,
        reason: 'test abort',
      }));
    });

    it('returns false for nonexistent pipeline', async () => {
      const aborted = await abortPipeline('nonexistent-id', 'test');
      expect(aborted).toBe(false);
    });
  });

  describe('getPipelineRun()', () => {
    it('returns active pipeline run', async () => {
      const run = await startPipeline('test-pipeline', 'test');
      const found = getPipelineRun(run!.id);
      expect(found).toBe(run);
    });

    it('returns null for unknown ID', () => {
      expect(getPipelineRun('unknown')).toBeNull();
    });
  });

  describe('registerPipelineListener()', () => {
    it('registers event listeners', () => {
      registerPipelineListener();
      expect(eventBus.on).toHaveBeenCalledWith('agent:task:completed', expect.any(Function));
      expect(eventBus.on).toHaveBeenCalledWith('agent:task:failed', expect.any(Function));
    });
  });
});

// ── HANDOFF Parser Tests ────────────────────────────────────────────

describe('parseHandoff()', () => {
  it('parses valid HANDOFF with all fields', () => {
    const output = 'Some agent output here\n\n---HANDOFF---\nTO: reviewer, qa\nINTENT: handoff\nARTIFACT_TYPE: code-change\nSUMMARY: Completed feature implementation';
    const result = parseHandoff(output);
    expect(result).not.toBeNull();
    expect(result!.to).toEqual(['reviewer', 'qa']);
    expect(result!.intent).toBe('handoff');
    expect(result!.artifactType).toBe('code-change');
    expect(result!.summary).toBe('Completed feature implementation');
  });

  it('parses HANDOFF with only required TO field', () => {
    const output = 'output\n---HANDOFF---\nTO: pm';
    const result = parseHandoff(output);
    expect(result).not.toBeNull();
    expect(result!.to).toEqual(['pm']);
    expect(result!.intent).toBe('handoff');
  });

  it('returns null when no HANDOFF marker', () => {
    expect(parseHandoff('just normal output')).toBeNull();
  });

  it('returns null when HANDOFF has no TO field', () => {
    const output = 'output\n---HANDOFF---\nINTENT: handoff';
    expect(parseHandoff(output)).toBeNull();
  });

  it('returns null when HANDOFF section is empty', () => {
    const output = 'output\n---HANDOFF---\n';
    expect(parseHandoff(output)).toBeNull();
  });

  it('handles feedback intent', () => {
    const output = 'output\n---HANDOFF---\nTO: programmer\nINTENT: feedback\nSUMMARY: Tests failing';
    const result = parseHandoff(output);
    expect(result!.intent).toBe('feedback');
    expect(result!.summary).toBe('Tests failing');
  });

  it('handles escalate intent', () => {
    const output = 'output\n---HANDOFF---\nTO: CTO\nINTENT: escalate\nSUMMARY: Cannot resolve';
    const result = parseHandoff(output);
    expect(result!.intent).toBe('escalate');
    expect(result!.to).toEqual(['CTO']);
  });

  it('defaults invalid intent to handoff', () => {
    const output = 'output\n---HANDOFF---\nTO: pm\nINTENT: invalid_intent';
    const result = parseHandoff(output);
    expect(result!.intent).toBe('handoff');
  });

  it('ignores invalid artifact types', () => {
    const output = 'output\n---HANDOFF---\nTO: pm\nARTIFACT_TYPE: unknown-type';
    const result = parseHandoff(output);
    expect(result!.artifactType).toBeUndefined();
  });

  it('uses last HANDOFF marker when multiple exist', () => {
    const output = '---HANDOFF---\nTO: old\n\nmore output\n---HANDOFF---\nTO: new';
    const result = parseHandoff(output);
    expect(result!.to).toEqual(['new']);
  });

  it('handles multiple TO targets', () => {
    const output = 'output\n---HANDOFF---\nTO: reviewer, qa, pm';
    const result = parseHandoff(output);
    expect(result!.to).toEqual(['reviewer', 'qa', 'pm']);
  });
});

describe('stripHandoff()', () => {
  it('removes HANDOFF section from output', () => {
    const output = 'Clean output here\n\n---HANDOFF---\nTO: pm\nINTENT: handoff';
    expect(stripHandoff(output)).toBe('Clean output here');
  });

  it('returns original output when no HANDOFF', () => {
    expect(stripHandoff('just normal output')).toBe('just normal output');
  });

  it('preserves content before HANDOFF', () => {
    const output = 'Line 1\nLine 2\nLine 3\n\n---HANDOFF---\nTO: reviewer';
    const result = stripHandoff(output);
    expect(result).toContain('Line 1');
    expect(result).toContain('Line 2');
    expect(result).toContain('Line 3');
    expect(result).not.toContain('HANDOFF');
  });
});

// ── StateMachine Mode Tests ─────────────────────────────────────────

describe('StateMachine mode', () => {
  const stateMachineTemplate: TeamTemplate = {
    name: 'test-sm-pipeline',
    description: 'stateMachine test',
    version: 1,
    members: [
      { agentName: 'programmer', teamRole: 'engineer', goal: 'Write code' },
      { agentName: 'reviewer', teamRole: 'reviewer', goal: 'Review code' },
      { agentName: 'qa', teamRole: 'qa', goal: 'Test code' },
      { agentName: 'pm', teamRole: 'pm', goal: 'Report' },
    ],
    workflow: {
      mode: 'stateMachine',
      stages: [
        {
          id: 'code',
          agentName: 'programmer',
          maxIterations: 3,
          transitions: { default: ['review', 'test'] },
        },
        {
          id: 'review',
          agentName: 'reviewer',
          inputFrom: ['code'],
          maxIterations: 2,
          transitions: { feedback: 'code', handoff: 'report', default: 'report' },
        },
        {
          id: 'test',
          agentName: 'qa',
          inputFrom: ['code'],
          maxIterations: 2,
          transitions: { feedback: 'code', handoff: 'report', default: 'report' },
        },
        {
          id: 'report',
          agentName: 'pm',
          inputFrom: ['review', 'test'],
          waitForAll: true,
          maxIterations: 1,
        },
      ],
    },
    budget: { maxTotalCostUsd: 5.0 },
    governance: {
      requireReviewStage: true,
      minConfidence: 0.6,
      escalateOnFailure: 'abort',
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadTeamTemplate).mockResolvedValue(stateMachineTemplate);
    let taskCounter = 0;
    vi.mocked(enqueueTask).mockImplementation(async () => `sm-task-${++taskCounter}`);
  });

  afterEach(() => {
    for (const p of getActivePipelines()) {
      abortPipeline(p.id, 'test cleanup');
    }
  });

  it('dispatches only entry stages (no inputFrom)', async () => {
    const run = await startPipeline('test-sm-pipeline', 'Implement feature X');
    expect(run).not.toBeNull();
    // Only 'code' stage should be dispatched (it has no inputFrom)
    expect(enqueueTask).toHaveBeenCalledTimes(1);
    expect(enqueueTask).toHaveBeenCalledWith('programmer', expect.any(String), 7);
    expect(run!.stages['code']!.status).toBe('running');
    expect(run!.stages['review']!.status).toBe('pending');
    expect(run!.stages['test']!.status).toBe('pending');
    expect(run!.stages['report']!.status).toBe('pending');
  });

  it('initializes iterationCounts for all stages', async () => {
    const run = await startPipeline('test-sm-pipeline', 'Implement feature X');
    expect(run!.iterationCounts).toBeDefined();
    // Entry stage dispatched → its counter should be 1
    expect(run!.iterationCounts!['code']).toBe(1);
    // Other stages not yet dispatched → counter is 0
    expect(run!.iterationCounts!['review']).toBe(0);
    expect(run!.iterationCounts!['test']).toBe(0);
    expect(run!.iterationCounts!['report']).toBe(0);
  });

  it('does not set iterationCounts for sequential mode', async () => {
    vi.mocked(loadTeamTemplate).mockResolvedValue({
      ...stateMachineTemplate,
      name: 'seq-pipeline',
      workflow: { ...stateMachineTemplate.workflow, mode: 'sequential' },
    });
    const run = await startPipeline('seq-pipeline', 'test');
    expect(run!.iterationCounts).toBeUndefined();
  });

  it('logs stateMachine mode in startup', async () => {
    const { logger } = await import('../../src/core/logger.js');
    await startPipeline('test-sm-pipeline', 'test');
    expect(logger.info).toHaveBeenCalledWith(
      'PipelineEngine',
      expect.stringContaining('stateMachine'),
    );
  });
});
