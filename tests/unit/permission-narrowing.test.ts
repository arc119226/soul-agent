import { describe, it, expect } from 'vitest';
import {
  narrowPermissions,
  buildScopedPermissionPrompt,
  type AgentPermissions,
  type TaskScope,
} from '../../src/agents/governance/agent-permissions.js';

describe('Permission Narrowing', () => {
  const basePermissions: AgentPermissions = {
    read: ['soul/**', 'src/**', 'blog/**', 'plugins/**'],
    write: ['soul/agent-reports/explorer/**'],
    execute: [],
  };

  describe('narrowPermissions()', () => {
    it('narrows read paths to scope', () => {
      const scope: TaskScope = {
        stageId: 'research',
        readPaths: ['soul/**'],
      };
      const narrowed = narrowPermissions(basePermissions, scope);
      expect(narrowed.read).toEqual(['soul/**']);
      expect(narrowed.write).toEqual(basePermissions.write); // unchanged
    });

    it('keeps all permissions when scope has no restrictions', () => {
      const scope: TaskScope = { stageId: 'test' };
      const narrowed = narrowPermissions(basePermissions, scope);
      expect(narrowed.read).toEqual(basePermissions.read);
      expect(narrowed.write).toEqual(basePermissions.write);
      expect(narrowed.execute).toEqual(basePermissions.execute);
    });

    it('narrows write paths', () => {
      const executorPerms: AgentPermissions = {
        read: ['soul/**', 'src/**'],
        write: ['src/**', 'plugins/**', 'soul/agent-reports/executor/**'],
        execute: ['git', 'npm test'],
      };
      const scope: TaskScope = {
        writePaths: ['src/**'],
      };
      const narrowed = narrowPermissions(executorPerms, scope);
      expect(narrowed.write).toEqual(['src/**']);
    });

    it('narrows execute commands', () => {
      const executorPerms: AgentPermissions = {
        read: ['src/**'],
        write: ['src/**'],
        execute: ['git', 'npm test', 'npm run', 'npx tsc'],
      };
      const scope: TaskScope = {
        executePaths: ['git', 'npm test'],
      };
      const narrowed = narrowPermissions(executorPerms, scope);
      expect(narrowed.execute).toEqual(['git', 'npm test']);
    });

    it('returns empty when scope has no overlap', () => {
      const scope: TaskScope = {
        readPaths: ['data/**'],
      };
      const narrowed = narrowPermissions(basePermissions, scope);
      expect(narrowed.read).toEqual([]);
    });
  });

  describe('buildScopedPermissionPrompt()', () => {
    it('includes stage ID in the prompt', () => {
      const scope: TaskScope = { stageId: 'research' };
      const prompt = buildScopedPermissionPrompt(
        'explorer',
        'observer',
        basePermissions,
        scope,
      );
      expect(prompt).toContain('research');
      expect(prompt).toContain('收窄');
    });

    it('includes base permission info', () => {
      const scope: TaskScope = {};
      const prompt = buildScopedPermissionPrompt(
        'explorer',
        'observer',
        basePermissions,
        scope,
      );
      expect(prompt).toContain('explorer');
      expect(prompt).toContain('observer');
    });
  });
});
