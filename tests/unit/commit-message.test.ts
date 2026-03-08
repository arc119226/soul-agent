import { describe, it, expect } from 'vitest';
import { buildConventionalCommitMessage } from '../../src/evolution/commit-message.js';
import type { Goal } from '../../src/evolution/goals.js';

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: 'test-01',
    description: 'Add new feature for testing',
    priority: 3,
    status: 'in_progress',
    tags: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('buildConventionalCommitMessage', () => {
  it('defaults to feat type', () => {
    const msg = buildConventionalCommitMessage(makeGoal(), 'low', false);
    expect(msg).toMatch(/^feat\(evolution\): /);
  });

  it('uses fix type for bug tags', () => {
    const msg = buildConventionalCommitMessage(
      makeGoal({ tags: ['bug'] }),
      'low',
      false,
    );
    expect(msg).toMatch(/^fix\(evolution\): /);
  });

  it('uses fix type for fix tags', () => {
    const msg = buildConventionalCommitMessage(
      makeGoal({ tags: ['fix'] }),
      'low',
      false,
    );
    expect(msg).toMatch(/^fix\(evolution\): /);
  });

  it('uses feat type for feature tags', () => {
    const msg = buildConventionalCommitMessage(
      makeGoal({ tags: ['feature'] }),
      'low',
      false,
    );
    expect(msg).toMatch(/^feat\(evolution\): /);
  });

  it('uses refactor type for refactor tags', () => {
    const msg = buildConventionalCommitMessage(
      makeGoal({ tags: ['refactor'] }),
      'low',
      false,
    );
    expect(msg).toMatch(/^refactor\(evolution\): /);
  });

  it('uses docs type for docs tags', () => {
    const msg = buildConventionalCommitMessage(
      makeGoal({ tags: ['docs'] }),
      'low',
      false,
    );
    expect(msg).toMatch(/^docs\(evolution\): /);
  });

  it('uses test type for test tags', () => {
    const msg = buildConventionalCommitMessage(
      makeGoal({ tags: ['test'] }),
      'low',
      false,
    );
    expect(msg).toMatch(/^test\(evolution\): /);
  });

  it('detects refactor from description', () => {
    const msg = buildConventionalCommitMessage(
      makeGoal({ description: 'Refactor the event bus' }),
      'low',
      false,
    );
    expect(msg).toMatch(/^refactor\(evolution\): /);
  });

  it('detects 重構 from description', () => {
    const msg = buildConventionalCommitMessage(
      makeGoal({ description: '重構記憶系統' }),
      'low',
      false,
    );
    expect(msg).toMatch(/^refactor\(evolution\): /);
  });

  it('adds body for high complexity', () => {
    const msg = buildConventionalCommitMessage(makeGoal(), 'high', false);
    expect(msg).toContain('\n\n');
    expect(msg).toContain('Complexity: high');
  });

  it('adds body when CLAUDE.md is updated', () => {
    const msg = buildConventionalCommitMessage(makeGoal(), 'low', true);
    expect(msg).toContain('\n\n');
    expect(msg).toContain('CLAUDE.md: auto-synced');
  });

  it('no body for low complexity without CLAUDE.md update', () => {
    const msg = buildConventionalCommitMessage(makeGoal(), 'low', false);
    expect(msg).not.toContain('\n\n');
  });

  it('truncates long descriptions', () => {
    const longDesc = 'A'.repeat(80);
    const msg = buildConventionalCommitMessage(
      makeGoal({ description: longDesc }),
      'low',
      false,
    );
    // Subject line should be truncated
    const firstLine = msg.split('\n')[0]!;
    expect(firstLine.length).toBeLessThan(100);
    expect(firstLine).toContain('...');
  });

  it('prioritizes tag-based type over description-based', () => {
    const msg = buildConventionalCommitMessage(
      makeGoal({ tags: ['bug'], description: 'Refactor something' }),
      'low',
      false,
    );
    // bug tag should win over "refactor" in description
    expect(msg).toMatch(/^fix\(evolution\): /);
  });
});
