/**
 * Agent role & permission definitions.
 *
 * Roles:
 *   observer — read-only access + writes to own reports (default)
 *   executor — can modify code and execute commands (evolution agents)
 *   guardian — monitor-only, can read everything but writes nothing except alerts
 *
 * Permissions are injected into the worker's system prompt so the Claude
 * model self-enforces them. Combined with Phase 3 operation grading in
 * approval-server, red-level operations from observers will be blocked.
 */

export type AgentRole = 'observer' | 'executor' | 'guardian';

export interface AgentPermissions {
  /** Glob patterns the agent can read */
  read: string[];
  /** Glob patterns the agent can write to */
  write: string[];
  /** Allowed Bash command prefixes (empty = no Bash) */
  execute: string[];
}

/**
 * Default permissions per role.
 */
const ROLE_DEFAULTS: Record<AgentRole, AgentPermissions> = {
  observer: {
    read: ['soul/**', 'src/**', 'blog/**', 'plugins/**'],
    write: [],  // Filled dynamically with agent's own report dir
    execute: [],
  },
  executor: {
    read: ['soul/**', 'src/**', 'blog/**', 'plugins/**', 'data/**'],
    write: ['src/**', 'plugins/**', 'blog/**'],
    execute: ['git', 'npm test', 'npm run', 'npx tsc', 'node'],
  },
  guardian: {
    read: ['soul/**', 'src/**', 'data/**'],
    write: [],  // Only own reports
    execute: [],
  },
};

/**
 * Get the effective permissions for an agent.
 * Merges role defaults with any explicit overrides from config.
 */
export function getEffectivePermissions(
  agentName: string,
  role: AgentRole = 'observer',
  overrides?: Partial<AgentPermissions>,
): AgentPermissions {
  const defaults = ROLE_DEFAULTS[role] ?? ROLE_DEFAULTS.observer;

  // Every agent can always write to their own report directory
  const ownReportDir = `soul/agent-reports/${agentName}/**`;

  const perms: AgentPermissions = {
    read: overrides?.read ?? [...defaults.read],
    write: overrides?.write ?? [...defaults.write, ownReportDir],
    execute: overrides?.execute ?? [...defaults.execute],
  };

  // Ensure own report dir is always included in write
  if (!perms.write.includes(ownReportDir)) {
    perms.write.push(ownReportDir);
  }

  return perms;
}

// ── Task-Scoped Permission Narrowing ─────────────────────────────────

export interface TaskScope {
  /** Stage ID in a pipeline (for audit trail) */
  stageId?: string;
  /** Restrict read access to these paths only */
  readPaths?: string[];
  /** Restrict write access to these paths only */
  writePaths?: string[];
  /** Restrict execute access to these commands only */
  executePaths?: string[];
}

/**
 * Narrow base permissions to a task scope.
 * Returns the intersection of base permissions and scope restrictions.
 * If a scope field is undefined, the base permission is kept unchanged.
 */
export function narrowPermissions(
  base: AgentPermissions,
  scope: TaskScope,
): AgentPermissions {
  return {
    read: scope.readPaths
      ? base.read.filter((p) => scope.readPaths!.some((sp) => p.startsWith(sp.replace('/**', '')) || sp === p))
      : base.read,
    write: scope.writePaths
      ? base.write.filter((p) => scope.writePaths!.some((sp) => p.startsWith(sp.replace('/**', '')) || sp === p))
      : base.write,
    execute: scope.executePaths
      ? base.execute.filter((cmd) => scope.executePaths!.includes(cmd))
      : base.execute,
  };
}

/**
 * Build a scoped permission prompt for pipeline tasks.
 * Includes the narrowed permissions and a note about the task scope.
 */
export function buildScopedPermissionPrompt(
  agentName: string,
  role: AgentRole,
  permissions: AgentPermissions,
  scope: TaskScope,
): string {
  const narrowed = narrowPermissions(permissions, scope);
  const base = buildPermissionPrompt(agentName, role, narrowed);

  const lines = [base];
  if (scope.stageId) {
    lines.push('');
    lines.push(`**任務範圍**：此權限已為 pipeline 階段「${scope.stageId}」收窄。僅限於上述列出的路徑和指令。`);
  }
  return lines.join('\n');
}

/**
 * Build a permission declaration string to inject into the worker system prompt.
 * This makes the Claude model aware of its boundaries.
 */
export function buildPermissionPrompt(
  agentName: string,
  role: AgentRole,
  permissions: AgentPermissions,
): string {
  const lines: string[] = [];

  lines.push(`## 權限範圍（${agentName}，角色：${role}）`);
  lines.push('');

  // Read access
  lines.push('**可讀取：**');
  for (const pattern of permissions.read) {
    lines.push(`- ${pattern}`);
  }

  // Write access
  lines.push('');
  lines.push('**可寫入：**');
  if (permissions.write.length === 0) {
    lines.push('- （無寫入權限）');
  } else {
    for (const pattern of permissions.write) {
      lines.push(`- ${pattern}`);
    }
  }

  // Execute access
  lines.push('');
  lines.push('**可執行的指令：**');
  if (permissions.execute.length === 0) {
    lines.push('- （無指令執行權限，不可使用 Bash 工具）');
  } else {
    for (const prefix of permissions.execute) {
      lines.push(`- ${prefix}*`);
    }
  }

  // Enforcement note
  lines.push('');
  lines.push('**重要：** 超出上述權限範圍的操作將被系統攔截。請嚴格遵守你的權限範圍。');

  return lines.join('\n');
}
