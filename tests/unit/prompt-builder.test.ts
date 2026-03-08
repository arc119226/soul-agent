import { describe, it, expect, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

vi.mock('../../src/core/debounced-writer.js', () => ({
  writer: { schedule: vi.fn() },
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/evolution/capabilities.js', () => ({
  getCapabilities: vi.fn(() => '## Core Capabilities\n- Can run tests'),
}));

vi.mock('../../src/evolution/changelog.js', () => ({
  getRecentChanges: vi.fn(async () => [
    { success: true, description: 'Added logging', lessonsLearned: 'Use structured logs' },
    { success: false, description: 'Failed validation', lessonsLearned: '' },
  ]),
}));

vi.mock('../../src/metacognition/curiosity.js', () => ({
  getCuriosityTopics: vi.fn(async () => [
    { topic: 'WebSocket integration', reason: 'real-time communication' },
  ]),
}));

import { buildEvolutionPrompt, type PromptContext } from '../../src/evolution/evolution-prompt.js';
import { readFile } from 'node:fs/promises';
import type { Goal } from '../../src/evolution/goals.js';

const mockGoal: Goal = {
  id: 'goal-test-001',
  description: 'Add unit tests for core modules',
  priority: 4,
  tags: ['testing', 'quality'],
  status: 'pending',
  createdAt: '2026-02-13T00:00:00Z',
};

describe('Prompt Builder', () => {
  it('includes goal details in the prompt', async () => {
    vi.mocked(readFile).mockResolvedValue('# CLAUDE.md content');

    const prompt = await buildEvolutionPrompt(mockGoal);

    expect(prompt).toContain('goal-test-001');
    expect(prompt).toContain('Add unit tests for core modules');
    expect(prompt).toContain('Priority: 4/5');
    expect(prompt).toContain('testing, quality');
  });

  it('includes safety rules', async () => {
    vi.mocked(readFile).mockResolvedValue('# CLAUDE.md');

    const prompt = await buildEvolutionPrompt(mockGoal);

    expect(prompt).toContain('SAFETY RULES');
    expect(prompt).toContain('NEVER modify any file under soul/');
    expect(prompt).toContain('NEVER modify src/memory/');
    expect(prompt).toContain('NEVER modify src/identity/');
  });

  it('includes file guidelines', async () => {
    vi.mocked(readFile).mockResolvedValue('# CLAUDE.md');

    const prompt = await buildEvolutionPrompt(mockGoal);

    expect(prompt).toContain('FILE CHANGE GUIDELINES');
    expect(prompt).toContain('Result<T>');
  });

  it('includes capabilities section', async () => {
    vi.mocked(readFile).mockResolvedValue('# CLAUDE.md');

    const prompt = await buildEvolutionPrompt(mockGoal);

    expect(prompt).toContain('Current Capabilities');
    expect(prompt).toContain('Can run tests');
  });

  it('includes CLAUDE.md content', async () => {
    vi.mocked(readFile).mockResolvedValue('# My Project CLAUDE.md\nSome content');

    const prompt = await buildEvolutionPrompt(mockGoal);

    expect(prompt).toContain('Project Context');
    expect(prompt).toContain('My Project CLAUDE.md');
  });

  it('includes recent evolution history', async () => {
    vi.mocked(readFile).mockResolvedValue('# CLAUDE.md');

    const prompt = await buildEvolutionPrompt(mockGoal);

    expect(prompt).toContain('[SUCCESS] Added logging');
    expect(prompt).toContain('[FAILED] Failed validation');
    expect(prompt).toContain('Lesson: Use structured logs');
  });

  it('includes curiosity topics', async () => {
    vi.mocked(readFile).mockResolvedValue('# CLAUDE.md');

    const prompt = await buildEvolutionPrompt(mockGoal);

    expect(prompt).toContain('Curiosity & Learning Direction');
    expect(prompt).toContain('WebSocket integration');
  });

  it('includes knowledge snippets from context', async () => {
    vi.mocked(readFile).mockResolvedValue('# CLAUDE.md');

    const ctx: PromptContext = {
      knowledgeSnippets: ['grammY supports middleware', 'Use ctx.reply() for responses'],
    };

    const prompt = await buildEvolutionPrompt(mockGoal, ctx);

    expect(prompt).toContain('Relevant Knowledge');
    expect(prompt).toContain('grammY supports middleware');
  });

  it('includes recent errors from context', async () => {
    vi.mocked(readFile).mockResolvedValue('# CLAUDE.md');

    const ctx: PromptContext = {
      recentErrors: ['TypeError: cannot read property X', 'tsc: TS2345'],
    };

    const prompt = await buildEvolutionPrompt(mockGoal, ctx);

    expect(prompt).toContain('Recent Errors to Avoid');
    expect(prompt).toContain('TypeError: cannot read property X');
  });

  it('includes additional instructions from context', async () => {
    vi.mocked(readFile).mockResolvedValue('# CLAUDE.md');

    const ctx: PromptContext = {
      additionalInstructions: 'Focus on ESM compatibility',
    };

    const prompt = await buildEvolutionPrompt(mockGoal, ctx);

    expect(prompt).toContain('Additional Instructions');
    expect(prompt).toContain('Focus on ESM compatibility');
  });

  it('includes expected output section', async () => {
    vi.mocked(readFile).mockResolvedValue('# CLAUDE.md');

    const prompt = await buildEvolutionPrompt(mockGoal);

    expect(prompt).toContain('Expected Output');
    expect(prompt).toContain('npx tsc --noEmit');
  });

  it('handles missing CLAUDE.md gracefully', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));

    const prompt = await buildEvolutionPrompt(mockGoal);

    // Should still produce a valid prompt without CLAUDE.md section
    expect(prompt).toContain('Evolution Task');
    expect(prompt).toContain('SAFETY RULES');
  });
});
