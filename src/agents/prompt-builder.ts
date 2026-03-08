/**
 * Prompt Builder — assembles agent system prompts with all context sections.
 *
 * Extracted from worker-scheduler.ts to reduce module size.
 * Pure function: reads configs, builds prompt string, returns metrics.
 */

import { logger } from '../core/logger.js';
import { getEffectivePermissions, buildPermissionPrompt, buildScopedPermissionPrompt } from './governance/agent-permissions.js';
import { loadAllAgentConfigs, type AgentConfig } from './config/agent-config.js';
import { truncateWithMarker, PIPELINE_CONTEXT_CAP } from './truncate-utils.js';
import type { AgentTask, PromptMetrics } from './task-types.js';

// ── Constants ────────────────────────────────────────────────────────

const MAX_CHAIN_DEPTH = 5;

const CAPABILITY_LABELS: Record<string, string> = {
  'code': '寫/改程式碼',
  'testing': '跑測試',
  'code-review': '審查程式碼',
  'architecture': '架構判斷',
  'design': '系統設計',
  'refactoring': '重構',
  'security': '安全問題',
  'monitoring': '持續監控',
  'research': '查資料/研究',
  'analysis': '分析判斷',
  'blog': '寫/發文章',
  'documentation': '文件/commit',
  'git': 'git 操作',
  'configuration': '配置修改',
  'planning': '排程/規劃',
  'project-management': '專案管理',
  'summarization': '摘要',
  'market-data': '市場數據',
};

const DISPATCH_CAPABLE_CAPS = new Set([
  'code', 'architecture', 'design', 'code-review', 'testing',
  'planning', 'project-management', 'blog', 'documentation',
  'configuration', 'deployment',
]);

const WRITE_TOOLS = ['Write', 'Edit', 'Bash', 'NotebookEdit'];

// ── Main Function ────────────────────────────────────────────────────

/** Build worker system prompt from agent config, with section-level metrics. */
export async function buildWorkerSystemPrompt(agentCfg: AgentConfig, task: AgentTask): Promise<{ prompt: string; metrics: PromptMetrics }> {
  const lines: string[] = [];
  const sectionSizes: Record<string, number> = {};
  let cursor = 0;

  const startSection = () => { cursor = lines.join('\n').length; };
  const endSection = (name: string) => { sectionSizes[name] = lines.join('\n').length - cursor; };

  // ── base: role intro + work principles ──
  startSection();
  lines.push(`你是「${agentCfg.name}」背景工作代理人。`);
  if (agentCfg.description) {
    lines.push(agentCfg.description);
  }

  lines.push('');
  lines.push('## 工作守則');
  lines.push('- 你在背景執行任務，主人不會直接看到你的即時輸出');
  lines.push('- 你的結果會被寫入報告，主意識會在適當時候讀取');
  lines.push('- 請盡量簡潔、結構化地回報發現');
  lines.push('- 如果有重要發現，請明確標記其重要性（1-5 分）');

  const role = agentCfg.role ?? 'observer';
  if (role === 'executor') {
    lines.push('- 你有程式碼寫入權限。完成修改後回報摘要');
  } else {
    lines.push('- 不要修改任何程式碼，只做調查和報告');
  }
  endSection('base');

  // ── personality ──
  if (agentCfg.personality) {
    startSection();
    const p = agentCfg.personality;
    lines.push('');
    lines.push('## 你的性格');
    const parts: string[] = [p.tagline];
    if (p.tone) parts.push(`語氣：${p.tone}`);
    if (p.opinionated !== undefined) {
      const level = p.opinionated >= 0.7 ? '主動提出見解' :
                    p.opinionated >= 0.4 ? '適度表達意見' : '專注執行，少評論';
      parts.push(level);
    }
    if (p.verbosity !== undefined) {
      const level = p.verbosity >= 0.7 ? '報告詳盡完整' :
                    p.verbosity >= 0.4 ? '中等篇幅' : '極簡扼要';
      parts.push(level);
    }
    lines.push(parts.join('。') + '。');
    endSection('personality');
  }

  // ── permissions ──
  startSection();
  const perms = getEffectivePermissions(agentCfg.name, role, agentCfg.permissions);

  const cfgAny = agentCfg as AgentConfig & { allowedTools?: string[]; deniedTools?: string[] };
  const hasWriteToolDenied = cfgAny.deniedTools?.length
    ? WRITE_TOOLS.every(t => cfgAny.deniedTools!.includes(t))
    : false;
  const hasNoWriteToolAllowed = cfgAny.allowedTools?.length
    ? !WRITE_TOOLS.some(t => cfgAny.allowedTools!.includes(t))
    : false;
  if (hasWriteToolDenied || hasNoWriteToolAllowed) {
    perms.write = [];
  }

  lines.push('');
  if (task.taskScope) {
    lines.push(buildScopedPermissionPrompt(agentCfg.name, role, perms, task.taskScope));
  } else {
    lines.push(buildPermissionPrompt(agentCfg.name, role, perms));
  }

  if (hasWriteToolDenied || hasNoWriteToolAllowed) {
    lines.push('');
    lines.push('**注意：** 你不需要寫入任何檔案。系統會自動將你的文字輸出儲存為報告。請直接在回覆中輸出完整報告內容即可。');
  }
  endSection('permissions');

  // ── toolRules ──
  if (cfgAny.allowedTools?.length || cfgAny.deniedTools?.length) {
    startSection();
    lines.push('');
    lines.push('## 工具權限限制');
    if (cfgAny.allowedTools?.length) {
      lines.push(`你只能使用以下工具：${cfgAny.allowedTools.join(', ')}。`);
      lines.push('嚴禁使用上述清單以外的任何工具。');
    }
    if (cfgAny.deniedTools?.length) {
      lines.push(`嚴禁使用以下工具：${cfgAny.deniedTools.join(', ')}。`);
    }
    endSection('toolRules');
  }

  // ── agentPrompt ──
  if (agentCfg.systemPrompt) {
    startSection();
    lines.push('');
    lines.push('## Agent 專屬指引');
    lines.push(agentCfg.systemPrompt);
    endSection('agentPrompt');
  }

  // ── projectConventions (injected for code/architecture/testing agents) ──
  {
    const caps = new Set(agentCfg.capabilities ?? []);
    if (caps.has('code') || caps.has('architecture') || caps.has('testing')) {
      startSection();
      lines.push('');
      lines.push('## 專案慣例');
      lines.push('- **ESM** — import/export，不用 require');
      lines.push('- **Result<T>** — evolution/safety/documents 模組用 ok()/fail() 回傳，不拋異常');
      lines.push('- **Atomic writes** — soul/ 寫入用 DebouncedWriter 或 soul-io（tmp → rename）');
      lines.push('- **JSONL append-only** — 事件流用 appendFile，不改既有行');
      lines.push('- **EventBus 解耦** — 模組間用事件通訊，不直接引用');
      lines.push('- **Timezone** — 用 getTodayString() 取當地日期');
      endSection('projectConventions');
    }
  }

  // ── researchBase (injected for market-data capability agents) ──
  {
    const caps = new Set(agentCfg.capabilities ?? []);
    if (caps.has('market-data')) {
      startSection();
      lines.push('');
      lines.push('## 研究通則');
      lines.push('');
      lines.push('### 研究步驟');
      lines.push('1. 用 `web_search` 搜尋最新數據（3-5 次，加上日期和關鍵字）');
      lines.push('2. 對有價值的連結用 `web_fetch` 深入閱讀');
      lines.push('3. 彙整成結構化分析報告');
      lines.push('4. 判斷是否值得發布為部落格文章');
      lines.push('');
      lines.push('### 注意事項');
      lines.push('- 用繁體中文撰寫');
      lines.push('- 每個數據點附上來源');
      lines.push('- 避免投資建議用語（說「值得觀察」而非「建議買入」）');
      lines.push('- 文章 800-1500 字');
      lines.push('- 重點是數據驅動的洞見，不是新聞搬運');
      lines.push('- 永遠標註數據的時效性（「截至 X 月 X 日」）');
      lines.push('');
      lines.push('### 發布流程');
      lines.push('如果判斷值得發布，用 `dispatch_task` 派給 blog-writer。');
      lines.push('dispatch_task 是非同步操作——派出後立即結束你的任務，不要等待下游結果。');
      lines.push('如果不值得發布，在報告結尾註明原因。');
      lines.push('');
      lines.push('### 錯誤處理');
      lines.push('- 工具呼叫失敗：記錄錯誤、嘗試替代搜尋詞、最多重試 1 次');
      lines.push('- 資料不足：如實回報「資料不足」，不要捏造數據，不要 dispatch 給 blog-writer');
      lines.push('- 超時風險：已用超過 70% turns 時，立即輸出已有結果');
      endSection('researchBase');
    }
  }

  // ── targets ──
  if (Object.keys(agentCfg.targets).length > 0) {
    startSection();
    lines.push('');
    lines.push('## 目標配置');
    lines.push(JSON.stringify(agentCfg.targets, null, 2));
    endSection('targets');
  }

  // ── teamCollaboration: merged agent directory + handoff + dispatch ──
  startSection();
  try {
    const allConfigs = await loadAllAgentConfigs();
    const dirLines: string[] = [];
    dirLines.push('## 團隊成員目錄');
    dirLines.push('');
    dirLines.push('完成任務後，如果需要交給下游 agent，必須在回覆最末尾附加 HANDOFF section。系統會自動解析並派工。這是唯一的交接方式——不要用 dispatch_task 交接。');
    dirLines.push('');
    dirLines.push('| Agent | 能力 | 找他的時機 |');
    dirLines.push('|-------|------|-----------|');

    for (const cfg of allConfigs) {
      if (!cfg.enabled || cfg.name === agentCfg.name) continue;
      const caps = (cfg.capabilities ?? [])
        .map(c => CAPABILITY_LABELS[c])
        .filter(Boolean)
        .slice(0, 2)
        .join('、') || cfg.name;
      dirLines.push(`| ${cfg.name} | ${(cfg.description ?? '').slice(0, 15)} | ${caps} |`);
    }

    dirLines.push('');
    dirLines.push('如果沒有適合的 agent → `TO: ESCALATE`，系統會通知管理層。');
    dirLines.push('');
    dirLines.push('### HANDOFF 格式（所有任務皆可使用）');
    dirLines.push('');
    dirLines.push('在回覆最末尾附加：');
    dirLines.push('```');
    dirLines.push('---HANDOFF---');
    dirLines.push('TO: {agent name 或 ESCALATE}');
    dirLines.push('INTENT: {handoff | feedback | escalate}');
    dirLines.push('ARTIFACT_TYPE: {code-change | report | review | test-result | analysis}');
    dirLines.push('SUMMARY: {一句話摘要}');
    dirLines.push('```');

    // ── dispatch_task: only for agents with cross-expertise delegation needs ──
    const needsDispatch = agentCfg.role === 'executor' ||
      (agentCfg.capabilities ?? []).some(c => DISPATCH_CAPABLE_CAPS.has(c));

    if (needsDispatch) {
      dirLines.push('');
      dirLines.push('### 橫向通訊（dispatch_task）');
      dirLines.push('');
      dirLines.push(`dispatch_task({agentName: "目標agent", prompt: "任務描述", parentTaskId: "${task.id}", originAgent: "${agentCfg.name}"})`);
      dirLines.push('只在你的專業無法完成子任務時使用。不用於流水線交接（用 HANDOFF）。');
    }

    dirLines.push(`- 當前 chain 深度：${task.chainDepth ?? 0}/${MAX_CHAIN_DEPTH}`);

    lines.push('');
    lines.push(dirLines.join('\n'));
  } catch (e) {
    logger.debug('PromptBuilder', `buildTeamCollaboration non-fatal: ${(e as Error).message}`);
  }
  endSection('teamCollaboration');

  // ── knowledgeBase (persistent team knowledge) ──
  startSection();
  try {
    const { queryKnowledgeBase } = await import('./knowledge/knowledge-base.js');
    const kbContent = await queryKnowledgeBase(agentCfg.name, task.prompt);
    if (kbContent) {
      lines.push('');
      lines.push(kbContent);
    }
  } catch (e) {
    logger.debug('PromptBuilder', `queryKnowledgeBase non-fatal: ${(e as Error).message}`);
  }
  endSection('knowledgeBase');

  // ── sharedKnowledge ──
  startSection();
  try {
    const { queryKnowledge } = await import('./knowledge/shared-knowledge.js');
    const knowledge = await queryKnowledge(agentCfg.name, task.prompt);
    if (knowledge) {
      lines.push('');
      lines.push(knowledge);
    }
  } catch (e) {
    logger.debug('PromptBuilder', `queryKnowledge non-fatal: ${(e as Error).message}`);
  }
  endSection('sharedKnowledge');

  // ── pipelineContext ──
  if (task.pipelineContext?.length) {
    startSection();
    lines.push('');
    lines.push('## 上游階段輸出（Pipeline Context）');
    lines.push('');
    lines.push('以下是 pipeline 中前序階段的產出摘要。完整內容請用 Read tool 讀取對應檔案：');

    let contextBudget = PIPELINE_CONTEXT_CAP;
    if (task.pipelineRunId) {
      try {
        const { getPipelineRun } = await import('./pipeline-engine.js');
        const { loadTeamTemplate } = await import('./config/team-config.js');
        const run = getPipelineRun(task.pipelineRunId);
        if (run) {
          const template = await loadTeamTemplate(run.teamName);
          if (template?.workflow.contextTokenBudget) {
            contextBudget = template.workflow.contextTokenBudget;
          }
        }
      } catch {
        // Non-fatal: fall back to default PIPELINE_CONTEXT_CAP
      }
    }

    for (const ctx of task.pipelineContext) {
      lines.push('');
      lines.push(`### Stage: ${ctx.stageId} (${ctx.agentName})`);
      lines.push('');
      if (ctx.artifactPath) {
        lines.push(`完整產出: ${ctx.artifactPath} (${ctx.output.length} 字元)`);
        lines.push(`請用 Read tool 讀取上述檔案以獲得完整內容。`);
      } else {
        lines.push(truncateWithMarker(ctx.output, contextBudget));
      }
    }
    endSection('pipelineContext');
  }

  // ── worktree context (for reviewer verification + secretary PR workflow) ──
  if (task.worktreePath && task.branchName) {
    startSection();
    lines.push('');
    lines.push('## Worktree 環境');
    lines.push('');
    lines.push(`你正在一個 git worktree 中工作：`);
    lines.push(`- **Worktree 路徑**: ${task.worktreePath}`);
    lines.push(`- **Branch 名稱**: ${task.branchName}`);
    lines.push(`- **工作目錄 (cwd)**: ${task.worktreePath}`);
    lines.push('');
    lines.push('如果你的角色是 reviewer/審查者：');
    lines.push('  - ⚠️ **必須從 worktree 路徑讀取檔案來驗證改動**，不要從主專案根目錄讀取（main branch 上還沒有改動）');
    lines.push('  - 你的 cwd 已設定為 worktree，直接用相對路徑讀取即可');
    lines.push('如果你的角色是 secretary，請使用 PR 流程（push branch → create PR → squash merge）而非直接 commit to main。');
    lines.push('');
    endSection('worktree-context');
  }

  // ── issueReporting ──
  startSection();
  lines.push('');
  lines.push('## 問題上報');
  lines.push('');
  lines.push('執行任務時若發現不屬於本次任務範圍的系統問題，用 HANDOFF 上報：');
  lines.push('```');
  lines.push('---HANDOFF---');
  lines.push('TO: ESCALATE');
  lines.push('INTENT: escalate');
  lines.push('ARTIFACT_TYPE: analysis');
  lines.push('SUMMARY: [P0-P3] [category] 一句話描述問題');
  lines.push('```');
  lines.push('Severity: P0=系統癱瘓 P1=功能異常 P2=需改善 P3=觀察。Category: system|logic|performance|security。');
  lines.push('只上報確認存在的問題，不上報猜測。上報後繼續完成你的本職任務。');
  endSection('issueReporting');

  // ── gitignoreReminder ──
  startSection();
  lines.push('');
  lines.push('## Git 追蹤注意事項');
  lines.push('');
  lines.push('注意：`soul/agent-reports/` 目錄在 `.gitignore` 中，寫入該目錄後不需要 INTENT: commit handoff。');
  lines.push('只有 `src/`、`plugins/`、`blog/` 等 git 追蹤目錄的改動才需要 commit。對 gitignored 路徑發出 INTENT: commit 將導致 secretary 失敗。');
  endSection('gitignoreReminder');

  // ── handoffReminder ──
  startSection();
  lines.push('');
  lines.push('## ⚠️ 任務完成後必須做的事');
  lines.push('完成任務後，你必須在回覆最末尾附加 ---HANDOFF--- 標記來告訴系統下一步交給誰。');
  lines.push('格式詳見下方「HANDOFF 格式」段落。忘記附加 = 任務鏈斷裂 = 浪費成本。');
  endSection('handoffReminder');

  // ── taskAnchor ──
  if (task.prompt.length > 0) {
    startSection();
    lines.push('');
    lines.push('## 本次任務核心目標（Critical Task Objective）');
    lines.push('');
    lines.push('**IMPORTANT**: 以下是你的核心任務目標，即使對話進行很久也請始終記住：');
    lines.push('');
    lines.push(task.prompt.slice(0, 500));
    endSection('taskAnchor');
  }

  const fullPrompt = lines.join('\n');
  return {
    prompt: fullPrompt,
    metrics: {
      totalChars: fullPrompt.length,
      sections: sectionSizes,
      knowledgeBaseChars: sectionSizes['knowledgeBase'] ?? 0,
      sharedKnowledgeChars: sectionSizes['sharedKnowledge'] ?? 0,
      pipelineContextChars: sectionSizes['pipelineContext'] ?? 0,
      taskAnchorChars: sectionSizes['taskAnchor'] ?? 0,
    },
  };
}
