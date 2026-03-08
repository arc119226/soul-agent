/**
 * 11-step evolution pipeline.
 * Steps: FetchKnowledge → BuildStrategy → RecordIntention → BuildPrompt → ClaudeCodeExec →
 *        TypeCheck → BasicValidation → RunTests → LayeredValidation → TrackOutcome → PostActions
 */

import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../core/logger.js';
import { eventBus } from '../core/event-bus.js';
import { ok, fail, isOk, type Result } from '../result.js';
import { config } from '../config.js';
import { getGoal, startGoal, completeGoal, failGoal, type Goal } from './goals.js';
import { buildEvolutionPrompt, type PromptContext } from './evolution-prompt.js';
import { validateSyntax, layeredValidation, type ValidationReport } from './validator.js';
import { createSafetyTag, rollback, cleanupSafetyTag, commitEvolutionWithMessage } from './rollback.js';
import { runPostEvolutionCleanup } from './cleanup.js';
import { buildConventionalCommitMessage } from './commit-message.js';
import { syncClaudeMd } from './claude-md-sync.js';
import { pushAfterEvolution } from './git-push.js';
import { recordSuccess, recordFailure, isOpen, getRecentFailures } from './circuit-breaker.js';
import { appendChangelog } from './changelog.js';
import { getCapabilities } from './capabilities.js';
import { recordIntention } from './intention-recorder.js';
import {
  startPipeline,
  advanceStep,
  recordPipelineError,
  clearPipeline,
  getPipelineState,
  hasInterruptedPipeline,
  getResumeStep,
  getStepIndex,
  getTotalSteps,
  type PipelineStep,
} from './pipeline-state.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const PROJECT_ROOT = process.cwd();

export interface PipelineResult {
  success: boolean;
  goalId: string;
  filesChanged: string[];
  error?: string;
  validationReport?: ValidationReport;
  requiresRestart: boolean;
}

type StepFn = (ctx: PipelineContext) => Promise<void>;

interface PipelineContext {
  goal: Goal;
  prompt: string;
  knowledgeSnippets: string[];
  filesChanged: string[];
  claudeOutput: string;
  validationReport?: ValidationReport;
  coreFilesChanged: boolean;
  /** Soul fingerprint hash before evolution (set by integrity gate) */
  preEvolutionHash?: string;
  /** Set to true when research/skill path handles the goal — skips remaining pipeline steps */
  earlyExit: boolean;
}

function createContext(goal: Goal): PipelineContext {
  return {
    goal,
    prompt: '',
    knowledgeSnippets: [],
    filesChanged: [],
    claudeOutput: '',
    coreFilesChanged: false,
    earlyExit: false,
  };
}

/**
 * Handle skill path — create a Markdown skill from goal description.
 * Throws error to trigger pipeline failure + rollback if skill creation fails.
 */
async function handleSkillPath(ctx: PipelineContext): Promise<void> {
  logger.info('pipeline', 'Executing SKILL path...');

  try {
    const { join } = await import('node:path');
    const { writeFile } = await import('node:fs/promises');

    // Generate skill name from goal description
    const keywords = ctx.goal.description
      .toLowerCase()
      .replace(/[^a-z0-9\s\u4e00-\u9fa5]/g, '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3);

    const skillName = keywords.join('-') || `auto-skill-${Date.now()}`;

    // Build Markdown skill file
    const markdown = [
      '---',
      `name: ${skillName}`,
      `description: ${ctx.goal.description}`,
      `keywords: [${keywords.map((k) => `"${k}"`).join(', ')}]`,
      'category: automation',
      'priority: 5',
      'enabled: true',
      '---',
      '',
      '## 目標',
      '',
      ctx.goal.description,
      '',
      '## 流程',
      '',
      '請根據上述目標執行對應操作。',
    ].join('\n');

    // Atomic write (tmp → rename)
    const skillPath = join(process.cwd(), 'soul', 'skills', `${skillName}.md`);
    const tmpPath = `${skillPath}.tmp`;
    await writeFile(tmpPath, markdown, 'utf-8');
    const { rename } = await import('node:fs/promises');
    await rename(tmpPath, skillPath);

    // Signal rebuild (same as MCP server does)
    const rebuildSignalPath = join(process.cwd(), 'soul', 'skills', '.rebuild');
    await writeFile(rebuildSignalPath, Date.now().toString(), 'utf-8');

    // Record in narrative
    const { appendNarrative } = await import('../identity/narrator.js');
    await appendNarrative('milestone', `通過演化系統建立了新技能：${skillName}`);

    logger.info('pipeline', `Skill created: ${skillName} at ${skillPath}`);

    // Track in changelog
    await appendChangelog({
      goalId: ctx.goal.id,
      description: ctx.goal.description,
      filesChanged: [skillPath],
      success: true,
      lessonsLearned: `Successfully created skill via SKILL path: ${skillName}`,
    });

    // Mark goal as completed
    completeGoal(ctx.goal.id);
    await clearPipeline();
    ctx.earlyExit = true;
    await eventBus.emit('evolution:success', { goalId: ctx.goal.id, description: ctx.goal.description });

    // Audit chain — record SKILL path success
    try {
      const { appendAuditEntry } = await import('../safety/audit-chain.js');
      await appendAuditEntry('evolution:success', {
        goalId: ctx.goal.id,
        description: ctx.goal.description,
        filesChanged: [skillPath],
        witnessNote: 'via SKILL path',
      });
    } catch { /* audit chain is non-critical */ }

    logger.info('pipeline', `SKILL path completed for goal ${ctx.goal.id}`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('pipeline', `SKILL path failed: ${errorMsg}`);

    // Record failure
    await appendChangelog({
      goalId: ctx.goal.id,
      description: ctx.goal.description,
      filesChanged: [],
      success: false,
      lessonsLearned: `SKILL path failed: ${errorMsg}`,
    });

    throw err; // Re-throw to trigger pipeline rollback
  }
}

/**
 * Goal-to-task mapping — tracks which agent tasks belong to which evolution goals.
 * Used by event listeners to update goal status when async tasks complete/fail.
 */
const goalTaskMap = new Map<string, string>(); // taskId → goalId

/**
 * Handle research path — dispatch goal to deep-researcher agent via worker scheduler.
 * Research goals need web search + source synthesis, not code changes.
 *
 * IMPORTANT: Goal is set to in_progress (not completed) because the actual research
 * runs asynchronously. Goal completion/failure is handled by event listeners
 * on 'agent:task:completed' and 'agent:task:failed'.
 */
async function handleResearchPath(ctx: PipelineContext): Promise<void> {
  logger.info('pipeline', 'Executing RESEARCH path...');

  try {
    const { enqueueTask } = await import('../agents/worker-scheduler.js');

    // Build a research prompt from the goal description
    const researchPrompt = buildResearchPrompt(ctx.goal.description);

    // Enqueue to deep-researcher agent with high priority
    const taskId = await enqueueTask('deep-researcher', researchPrompt, 8);

    // Track the goal ↔ task mapping for async completion
    goalTaskMap.set(taskId, ctx.goal.id);

    logger.info('pipeline', `Research task enqueued: ${taskId} for goal ${ctx.goal.id}`);

    // Record in narrative
    const { appendNarrative } = await import('../identity/narrator.js');
    await appendNarrative('evolution', `派遣深度研究任務：${ctx.goal.description.slice(0, 50)}`, {
      significance: 2,
      emotion: '好奇',
      related_to: 'research',
    });

    // Track in changelog (dispatch event, not final result)
    await appendChangelog({
      goalId: ctx.goal.id,
      description: ctx.goal.description,
      filesChanged: [],
      success: true,
      lessonsLearned: `Dispatched to deep-researcher agent (task: ${taskId}), awaiting async completion`,
    });

    // Keep goal as in_progress — actual completion is tracked via events
    startGoal(ctx.goal.id);
    await clearPipeline();
    ctx.earlyExit = true;

    logger.info('pipeline', `RESEARCH path dispatched for goal ${ctx.goal.id} (awaiting async result)`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('pipeline', `RESEARCH path failed: ${errorMsg}`);

    await appendChangelog({
      goalId: ctx.goal.id,
      description: ctx.goal.description,
      filesChanged: [],
      success: false,
      lessonsLearned: `RESEARCH path failed: ${errorMsg}`,
    });

    throw err;
  }
}

// ── Research Task Event Listeners ──────────────────────────────────

/** Set up listeners for async research task completion/failure. */
function initResearchTaskListeners(): void {
  eventBus.on('agent:task:completed', async (data) => {
    const goalId = goalTaskMap.get(data.taskId);
    if (!goalId) return; // Not a research-dispatched task

    goalTaskMap.delete(data.taskId);
    completeGoal(goalId);

    // Mark curiosity topic as explored when research completes
    const completedGoal = getGoal(goalId);
    if (completedGoal) {
      const curiosityMatch = completedGoal.description.match(/^探索好奇心話題：(.+)$/);
      if (curiosityMatch) {
        try {
          const { markExplored } = await import('../metacognition/curiosity.js');
          await markExplored(curiosityMatch[1]!);
          logger.info('pipeline', `Marked curiosity topic as explored: ${curiosityMatch[1]!.slice(0, 40)}`);
        } catch { /* non-critical */ }
      }
    }

    await appendChangelog({
      goalId,
      description: `Research task ${data.taskId} completed`,
      filesChanged: [],
      success: true,
      lessonsLearned: `Deep-researcher task completed successfully`,
    });

    await eventBus.emit('evolution:success', { goalId, description: `Research completed: ${data.result.slice(0, 80)}` });

    // Audit chain — record RESEARCH path success
    try {
      const { appendAuditEntry } = await import('../safety/audit-chain.js');
      await appendAuditEntry('evolution:success', {
        goalId,
        description: `Research completed: ${data.result.slice(0, 80)}`,
        witnessNote: `via RESEARCH path, taskId=${data.taskId}`,
      });
    } catch { /* audit chain is non-critical */ }

    logger.info('pipeline', `Research goal ${goalId} completed via task ${data.taskId}`);
  });

  eventBus.on('agent:task:failed', async (data) => {
    const goalId = goalTaskMap.get(data.taskId);
    if (!goalId) return; // Not a research-dispatched task

    goalTaskMap.delete(data.taskId);
    failGoal(goalId, `Research task failed: ${data.error}`, 'research');

    // Mark curiosity topic as explored if permanently abandoned
    const failedGoal = getGoal(goalId);
    if (failedGoal?.status === 'failed') {
      const curiosityMatch = failedGoal.description.match(/^探索好奇心話題：(.+)$/);
      if (curiosityMatch) {
        try {
          const { markExplored } = await import('../metacognition/curiosity.js');
          await markExplored(curiosityMatch[1]!);
          logger.info('pipeline', `Marked curiosity topic as explored (abandoned): ${curiosityMatch[1]!.slice(0, 40)}`);
        } catch { /* non-critical */ }
      }
    }

    await appendChangelog({
      goalId,
      description: `Research task ${data.taskId} failed`,
      filesChanged: [],
      success: false,
      lessonsLearned: `Deep-researcher task failed: ${data.error}`,
    });

    await eventBus.emit('evolution:fail', { goalId, error: data.error });

    // Audit chain — record RESEARCH path failure
    try {
      const { appendAuditEntry } = await import('../safety/audit-chain.js');
      await appendAuditEntry('evolution:fail', {
        goalId,
        description: `Research task ${data.taskId} failed`,
        error: data.error,
        witnessNote: `via RESEARCH path, taskId=${data.taskId}`,
      });
    } catch { /* audit chain is non-critical */ }

    logger.warn('pipeline', `Research goal ${goalId} failed via task ${data.taskId}: ${data.error}`);
  });
}

/** Build a structured research prompt from a goal description. */
function buildResearchPrompt(description: string): string {
  // Extract the actual topic (strip "深入研究：" prefix if present)
  const topic = description.replace(/^深入研究[：:]\s*/i, '').trim();

  return [
    `## 深度研究任務`,
    '',
    `主題：${topic}`,
    '',
    `## 研究步驟`,
    '',
    '1. 用 2-3 次搜尋理解主題的全貌',
    '2. 閱讀最相關的 2-3 個網頁，提取關鍵資訊',
    '3. 彙整成結構化的研究報告',
    '',
    '## 報告格式',
    '',
    '```',
    '# {主題} 深度研究報告',
    '',
    '> 研究日期：{今天日期}',
    '',
    '## 概述',
    '{2-3 句概括}',
    '',
    '## 關鍵發現',
    '### 1. {發現標題}',
    '{說明，附來源}',
    '',
    '### 2. {發現標題}',
    '{說明，附來源}',
    '',
    '(列出 3-5 個關鍵發現)',
    '',
    '## 與我們專案的關聯',
    '{這些發現對 本專案有什麼啟發或應用？}',
    '',
    '## 延伸問題',
    '1. {值得繼續研究的問題}',
    '2. {值得繼續研究的問題}',
    '',
    '## 重要性：X/5',
    '```',
    '',
    '## 注意事項',
    '- 用繁體中文撰寫',
    '- 每個發現標注來源（URL）',
    '- 整份報告 500-1000 字',
    '- 重點是有用的洞察，不是純粹的資訊搬運',
  ].join('\n');
}

/** Step 1: Fetch knowledge from configured URLs */
async function stepFetchKnowledge(ctx: PipelineContext): Promise<void> {
  logger.info('pipeline', `[1/${STEP_ORDER.length}] Fetching knowledge...`);

  const urls = config.KNOWLEDGE_URLS;
  if (urls.length === 0) {
    ctx.knowledgeSnippets = [];
    return;
  }

  // Fetch knowledge URLs with timeout
  for (const url of urls.slice(0, 3)) {
    try {
      const { stdout } = await execAsync(`curl -s -m 10 "${url}"`, {
        cwd: PROJECT_ROOT,
        timeout: 15_000,
      });
      if (stdout.trim()) {
        ctx.knowledgeSnippets.push(`Source: ${url}\n${stdout.slice(0, 2000)}`);
      }
    } catch {
      logger.warn('pipeline', `Failed to fetch knowledge from ${url}`);
    }
  }
}

/**
 * Categories that represent behavioral/scoring issues, not code bugs.
 * Goals targeting these categories should be fast-rejected — code evolution cannot fix them.
 */
const NON_CODE_REPAIR_CATEGORIES = new Set([
  'reply-quality', 'interaction', 'evolution',
  'exploration', 'memory-compression', 'agent-tuning', 'curiosity',
]);

/** Step 2: Build strategy (analyze goal and capabilities) */
async function stepBuildStrategy(ctx: PipelineContext): Promise<void> {
  logger.info('pipeline', `[2/${STEP_ORDER.length}] Building strategy...`);

  // Goal quality gate — reject goals that are too vague for automated evolution
  const descLen = ctx.goal.description.trim().length;
  if (descLen < 10) {
    const reason = `Goal description too short (${descLen} chars) — automated evolution needs specific, actionable descriptions`;
    logger.info('pipeline', `Quality gate reject: ${reason}`);
    throw new Error(reason);
  }

  // Fast-reject: Goals that target non-code categories are impossible to fix via code evolution.
  // e.g. "修復反覆失敗：reply-quality（5 次失敗）" — reply-quality is a scoring metric, not a code bug.
  const repairMatch = ctx.goal.description.match(/^修復反覆失敗：(\S+)/);
  if (repairMatch) {
    const category = repairMatch[1]!.replace(/（.*$/, ''); // strip trailing count
    if (NON_CODE_REPAIR_CATEGORIES.has(category)) {
      const reason = `${category} is not a code bug — it reflects behavioral/scoring quality, not fixable by code evolution`;
      logger.info('pipeline', `Fast-reject: ${reason}`);
      throw new Error(reason);
    }
  }

  // PHASE 2.7: Route decision (research vs skill vs code path)
  try {
    const { shouldUseResearchPath, shouldUseSkillPath } = await import('./route-decision.js');

    // Check research path first (highest priority — avoids wasting Claude Code on research tasks)
    const useResearchPath = await shouldUseResearchPath(ctx.goal);
    if (useResearchPath) {
      logger.info('pipeline', 'Route decision: RESEARCH path — delegating to deep-researcher agent');
      await handleResearchPath(ctx);
      return; // Early exit — research runs asynchronously via worker
    }

    const useSkillPath = await shouldUseSkillPath(ctx.goal);
    if (useSkillPath) {
      logger.info('pipeline', 'Route decision: SKILL path — delegating to skill-auto-create');
      await handleSkillPath(ctx);
      return; // Early exit — skill path doesn't need code execution
    }
    logger.info('pipeline', 'Route decision: CODE path — proceeding with Claude Code execution');
  } catch (err) {
    logger.warn('pipeline', 'Route decision failed, defaulting to CODE path', err);
  }

  // Determine if it's a plugin change or core change
  const desc = ctx.goal.description.toLowerCase();
  ctx.coreFilesChanged =
    desc.includes('core') ||
    desc.includes('src/') ||
    desc.includes('refactor') ||
    desc.includes('architecture');

  // Inject failure history as strategy hints
  const recentFailures = getRecentFailures();
  if (recentFailures.length > 0) {
    // Group failures by type and build targeted advice
    const typeCounts = new Map<string, number>();
    for (const f of recentFailures) {
      typeCounts.set(f.type, (typeCounts.get(f.type) ?? 0) + 1);
    }

    const hints: string[] = [];
    if (typeCounts.has('type-check')) {
      hints.push(`注意：最近有 ${typeCounts.get('type-check')} 次 TypeScript 型別檢查失敗，請特別注意型別安全`);
    }
    if (typeCounts.has('timeout')) {
      hints.push(`注意：最近有 ${typeCounts.get('timeout')} 次超時，請控制修改範圍和複雜度`);
    }
    if (typeCounts.has('validation')) {
      hints.push(`注意：最近有 ${typeCounts.get('validation')} 次驗證失敗，請確保不修改受保護的路徑`);
    }
    if (typeCounts.has('test-failure')) {
      hints.push(`注意：最近有 ${typeCounts.get('test-failure')} 次測試失敗，請確保修改不破壞現有功能`);
    }
    if (typeCounts.has('runtime')) {
      hints.push(`注意：最近有 ${typeCounts.get('runtime')} 次運行時錯誤，請小心引入邏輯錯誤`);
    }

    if (hints.length > 0) {
      ctx.knowledgeSnippets.push(`[失敗歷史提醒]\n${hints.join('\n')}`);
      logger.info('pipeline', `Injected ${hints.length} failure-based strategy hints`);
    }
  }

  // Try to get strategy advice from Analyst agent (graceful fallback)
  try {
    const { agentBus } = await import('../agents/governance/agent-bus.js');
    const { AgentRole } = await import('../agents/types.js');

    if (agentBus.hasAgent(AgentRole.Analyst)) {
      const response = await agentBus.send({
        from: AgentRole.Coordinator,
        to: AgentRole.Analyst,
        type: 'suggest_strategy',
        payload: { goalId: ctx.goal.id, description: ctx.goal.description },
      });

      if (response.success && response.data) {
        const strategy = response.data as Record<string, unknown>;
        ctx.knowledgeSnippets.push(
          `[Analyst Strategy] Approach: ${strategy.approach}, Notes: ${strategy.notes}`,
        );
        logger.info('pipeline', `Analyst strategy: approach=${strategy.approach}`);
      }
    }
  } catch (err) {
    logger.warn('pipeline', 'Analyst strategy unavailable, proceeding without', err);
  }
}

/** Step 2.5: Record evolution intention */
async function stepRecordIntention(ctx: PipelineContext): Promise<void> {
  const total = STEP_ORDER.length;
  const idx = STEP_ORDER.indexOf('record_intention');
  logger.info('pipeline', `[${idx + 1}/${total}] Recording evolution intention...`);

  const intention = await recordIntention(ctx.goal);

  // Inject intention context so Claude sees the "why" during evolution
  ctx.knowledgeSnippets.push(
    `[Evolution Intention]\n` +
    `動機：${intention.motivation}\n` +
    `預期結果：${intention.expectedOutcome}\n` +
    `風險評估：${intention.riskAssessment}\n` +
    `複雜度：${intention.complexity}\n` +
    `影響範圍：${intention.affectedAreas.join(', ')}\n` +
    `相關歷史演化：${intention.precedents.length > 0 ? intention.precedents.join(', ') : '首次'}`,
  );
}

/** Step 3: Build prompt for Claude Code */
async function stepBuildPrompt(ctx: PipelineContext): Promise<void> {
  logger.info('pipeline', `[4/${STEP_ORDER.length}] Building evolution prompt...`);

  const promptCtx: PromptContext = {
    knowledgeSnippets: ctx.knowledgeSnippets,
  };

  ctx.prompt = await buildEvolutionPrompt(ctx.goal, promptCtx);
}

/** Step 4: Execute Claude Code CLI */
async function stepClaudeExec(ctx: PipelineContext): Promise<void> {
  logger.info('pipeline', `[5/${STEP_ORDER.length}] Executing Claude Code...`);

  try {
    // Build args array — execFile passes args directly, no shell escaping needed
    const args = ['-p', ctx.prompt];

    if (config.CLAUDE_CODE_CWD) {
      args.push('--cwd', config.CLAUDE_CODE_CWD);
    }
    if (config.CLAUDE_CODE_MODEL) {
      args.push('--model', config.CLAUDE_CODE_MODEL);
    }
    if (config.CLAUDE_CODE_MAX_TURNS > 0) {
      args.push('--max-turns', String(config.CLAUDE_CODE_MAX_TURNS));
    }
    if (config.EVOLVE_TRUST_MODE) {
      args.push('--dangerously-skip-permissions');
    }
    args.push('--output-format', 'json');

    const { stdout } = await execFileAsync('claude', args, {
      cwd: PROJECT_ROOT,
      timeout: config.CLAUDE_CODE_TIMEOUT,
      env: { ...process.env },
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });

    ctx.claudeOutput = stdout;

    // Use git diff to detect actual file changes (more reliable than regex parsing)
    try {
      const { stdout: diffOutput } = await execFileAsync('git', ['diff', '--name-only', 'HEAD'], {
        cwd: PROJECT_ROOT,
        timeout: 10_000,
      });
      const gitFiles = diffOutput
        .split('\n')
        .map((f) => f.trim())
        .filter((f) => f.length > 0 && (f.startsWith('src/') || f.startsWith('plugins/')));
      if (gitFiles.length > 0) {
        ctx.filesChanged = [...new Set(gitFiles)];
      }
    } catch {
      logger.warn('pipeline', 'git diff failed, falling back to regex-based file detection');
    }

    // Fallback: regex-based detection from Claude output if git diff found nothing
    if (ctx.filesChanged.length === 0) {
      try {
        const result = JSON.parse(stdout);
        if (result?.result) {
          const fileMatches = (result.result as string).match(/(?:src|plugins)\/[\w/.-]+\.ts/g);
          if (fileMatches) {
            ctx.filesChanged = [...new Set(fileMatches)];
          }
        }
      } catch {
        const fileMatches = stdout.match(/(?:src|plugins)\/[\w/.-]+\.ts/g);
        if (fileMatches) {
          ctx.filesChanged = [...new Set(fileMatches)];
        }
      }
    }

    logger.info('pipeline', `Claude Code returned, ${ctx.filesChanged.length} file(s) detected`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Claude Code execution failed: ${msg}`);
  }
}

/** Step 5: TypeScript type check */
async function stepTypeCheck(ctx: PipelineContext): Promise<void> {
  logger.info('pipeline', `[6/${STEP_ORDER.length}] Running type check...`);

  const result = await validateSyntax();
  if (!result.ok) {
    throw new Error(`Type check failed: ${result.error}`);
  }
}

/** Step 6: Basic validation (file existence + soul-guard + integrity gate) */
async function stepBasicValidation(ctx: PipelineContext): Promise<void> {
  logger.info('pipeline', `[7/${STEP_ORDER.length}] Running basic validation...`);

  // Pre-evolution integrity gate — verify soul files haven't been tampered with
  try {
    const { preEvolutionCheck } = await import('./integrity-gate.js');
    const { getFingerprint } = await import('../identity/vitals.js');
    const storedHash = await getFingerprint();
    const preCheck = await preEvolutionCheck(ctx.goal.id, storedHash);
    if (preCheck.ok) {
      ctx.preEvolutionHash = preCheck.value.hash;
    } else {
      // When EVOLUTION_PRE_CHECK_STRICT=true, mismatch returns fail() → block pipeline
      recordFailure(preCheck.error);
      throw new Error(preCheck.error);
    }
  } catch (err) {
    // Re-throw integrity blocks; only swallow unexpected errors
    if (err instanceof Error && err.message.includes('integrity mismatch blocked')) {
      throw err;
    }
    logger.warn('pipeline', 'Pre-evolution integrity check failed (non-fatal)', err);
  }

  // Quick sanity checks on changed files
  if (ctx.filesChanged.length === 0) {
    logger.warn('pipeline', 'No files detected as changed');
    return;
  }

  // Soul-guard: reject changes to protected paths (soul/, src/memory/, src/identity/)
  const { validateEvolutionTarget } = await import('../memory/soul-guard.js');
  const guardResult = validateEvolutionTarget(ctx.filesChanged);
  if (!guardResult.ok) {
    throw new Error(guardResult.error);
  }

  const { access } = await import('node:fs/promises');
  const { join } = await import('node:path');

  for (const file of ctx.filesChanged) {
    try {
      await access(join(PROJECT_ROOT, file));
    } catch {
      throw new Error(`Changed file not found: ${file}`);
    }
  }
}

/** Step 8: Run tests (vitest) */
async function stepRunTests(ctx: PipelineContext): Promise<void> {
  logger.info('pipeline', `[8/${STEP_ORDER.length}] Running tests...`);

  if (ctx.filesChanged.length === 0) {
    logger.info('pipeline', 'No files changed, skipping tests');
    return;
  }

  try {
    const { stdout } = await execAsync('npx vitest run --reporter=json', {
      cwd: PROJECT_ROOT,
      timeout: 120_000,
      env: { ...process.env, CI: 'true' },
    });

    // Parse JSON output
    try {
      const result = JSON.parse(stdout);
      if (result.success === false) {
        const failedTests = (result.testResults ?? [])
          .filter((t: { status: string }) => t.status === 'failed')
          .map((t: { name: string }) => t.name);
        throw new Error(
          `Tests failed (${result.numFailedTests ?? failedTests.length} failures): ${failedTests.join(', ')}`,
        );
      }
      logger.info('pipeline', `All tests passed (${result.numPassedTests ?? '?'} passed)`);
    } catch (parseErr) {
      // If it's our own thrown error, re-throw
      if (parseErr instanceof Error && parseErr.message.startsWith('Tests failed')) {
        throw parseErr;
      }
      // JSON parse failed — check raw output for "No test files found"
      if (stdout.includes('No test files found')) {
        logger.warn('pipeline', 'No test files found, proceeding');
        return;
      }
      // Otherwise tests likely passed but output wasn't clean JSON
      logger.warn('pipeline', 'Could not parse test JSON output, assuming pass');
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Tests failed')) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    // "No test files found" is non-fatal
    if (msg.includes('No test files found')) {
      logger.warn('pipeline', 'No test files found, proceeding');
      return;
    }
    throw new Error(`Test execution failed: ${msg}`);
  }
}

/** Step 9: Layered validation */
async function stepLayeredValidation(ctx: PipelineContext): Promise<void> {
  logger.info('pipeline', `[8/${STEP_ORDER.length}] Running layered validation...`);

  if (ctx.filesChanged.length === 0) return;

  const result = await layeredValidation(ctx.filesChanged);
  if (isOk(result)) {
    ctx.validationReport = result.value;
    if (!result.value.passed) {
      const hints = result.value.issues
        .map((i) => `  ${i.layer}/${i.file}: ${i.message} (fix: ${i.fixHint})`)
        .join('\n');
      throw new Error(`Layered validation failed:\n${hints}`);
    }
  }
}

/** Step 8: Track outcome in changelog */
async function stepTrackOutcome(ctx: PipelineContext): Promise<void> {
  logger.info('pipeline', `[9/${STEP_ORDER.length}] Tracking outcome...`);

  await appendChangelog({
    goalId: ctx.goal.id,
    description: ctx.goal.description,
    filesChanged: ctx.filesChanged,
    success: true,
    lessonsLearned: `Successfully evolved: ${ctx.filesChanged.length} file(s) changed`,
  });
}

/** Step 11: Post actions (commit, cleanup, push, hot-reload/restart) */
async function stepPostActions(ctx: PipelineContext): Promise<void> {
  logger.info('pipeline', `[${STEP_ORDER.length}/${STEP_ORDER.length}] Running post-actions...`);

  // 0. Post-evolution integrity gate — verify evolution didn't modify soul files
  if (ctx.preEvolutionHash) {
    try {
      const { postEvolutionCheck } = await import('./integrity-gate.js');
      const postCheck = await postEvolutionCheck(ctx.goal.id, ctx.preEvolutionHash);
      if (!postCheck.ok) {
        throw new Error(postCheck.error);
      }
      // Update stored fingerprint after successful evolution
      const { setFingerprint } = await import('../identity/vitals.js');
      await setFingerprint(postCheck.value.hash);
    } catch (err) {
      if (err instanceof Error && err.message.includes('critical violation')) {
        throw err; // Re-throw to trigger rollback
      }
      logger.warn('pipeline', 'Post-evolution integrity check failed (non-fatal)', err);
    }
  }

  // 1. Sync CLAUDE.md (before commit)
  let claudeMdUpdated = false;
  try {
    const syncResult = await syncClaudeMd(ctx.filesChanged);
    if (syncResult.ok) {
      claudeMdUpdated = syncResult.value.updated;
      if (claudeMdUpdated) {
        logger.info('pipeline', `CLAUDE.md synced: ${syncResult.value.sections.join(', ')}`);
      }
    }
  } catch (err) {
    logger.warn('pipeline', 'CLAUDE.md sync failed (non-fatal)', err);
  }

  // 2. Build conventional commit message
  const { recordIntention: getIntention } = await import('./intention-recorder.js');
  const intention = await getIntention(ctx.goal);
  const commitMsg = buildConventionalCommitMessage(ctx.goal, intention.complexity, claudeMdUpdated);

  // 3. Commit with conventional message
  const commitResult = await commitEvolutionWithMessage(ctx.goal.id, commitMsg);
  const commitHash = commitResult.ok ? commitResult.value : '';

  // 4. Cleanup safety tag
  await cleanupSafetyTag(ctx.goal.id);

  // 5. Auto-discover capability
  if (ctx.filesChanged.length > 0) {
    try {
      const { addCapability } = await import('./capabilities.js');
      addCapability(`進化 ${ctx.goal.id}: ${ctx.goal.description}`);
    } catch { /* non-critical */ }
  }

  // 6. Plugin/core change detection
  const hasPluginChanges = ctx.filesChanged.some((f) => f.startsWith('plugins/'));
  const hasCoreChanges = ctx.filesChanged.some(
    (f) => f.startsWith('src/') && !f.startsWith('src/plugins/'),
  );

  if (hasPluginChanges && !hasCoreChanges) {
    await eventBus.emit('plugin:reloaded', { name: 'evolution-triggered' });
    logger.info('pipeline', 'Triggered plugin hot-reload');
  }

  // 7. Post-evolution cleanup
  await runPostEvolutionCleanup();

  // 8. Auto push
  try {
    await pushAfterEvolution(ctx.goal, intention.complexity, commitHash);
  } catch (err) {
    logger.warn('pipeline', 'Auto push failed (non-fatal)', err);
  }

  // 9. Flag core changes for restart
  ctx.coreFilesChanged = hasCoreChanges;
}

const STEP_MAP: Record<PipelineStep, StepFn | null> = {
  idle: null,
  fetch_knowledge: stepFetchKnowledge,
  build_strategy: stepBuildStrategy,
  record_intention: stepRecordIntention,
  build_prompt: stepBuildPrompt,
  claude_exec: stepClaudeExec,
  type_check: stepTypeCheck,
  basic_validation: stepBasicValidation,
  run_tests: stepRunTests,
  layered_validation: stepLayeredValidation,
  track_outcome: stepTrackOutcome,
  post_actions: stepPostActions,
};

const STEP_ORDER: PipelineStep[] = [
  'fetch_knowledge',
  'build_strategy',
  'record_intention',
  'build_prompt',
  'claude_exec',
  'type_check',
  'basic_validation',
  'run_tests',
  'layered_validation',
  'track_outcome',
  'post_actions',
];

/** Execute the full evolution pipeline for a goal */
export async function executePipeline(goalId: string): Promise<Result<PipelineResult>> {
  // Check kill switch (safety mode)
  try {
    const { isRestricted } = await import('../safety/kill-switch.js');
    if (isRestricted()) {
      return fail(
        'Kill switch active — evolution paused in safety mode',
        'Wait for anomalies to clear or admin force-reset',
      );
    }
  } catch {
    // kill-switch unavailable — proceed
  }

  // Check circuit breaker
  if (isOpen()) {
    return fail(
      'Circuit breaker is open — too many consecutive failures',
      'Wait for cooldown or force-reset the circuit breaker',
    );
  }

  // Load goal
  const goal = getGoal(goalId);
  if (!goal) {
    return fail(`Goal not found: ${goalId}`);
  }

  const pipelineStartTime = Date.now();

  logger.info('pipeline', `Starting evolution pipeline for goal: ${goal.id} — ${goal.description}`);
  await eventBus.emit('evolution:start', { goalId: goal.id, description: goal.description });

  // Record pre-evolution soul fingerprint for post-evolution integrity check
  let preSoulHash: string | null = null;
  try {
    const { computeSoulFingerprint } = await import('../safety/soul-integrity.js');
    const beforeFp = await computeSoulFingerprint();
    if (beforeFp.ok) preSoulHash = beforeFp.value.hash;

    // Audit chain — record evolution start with before-fingerprint
    const { appendAuditEntry } = await import('../safety/audit-chain.js');
    await appendAuditEntry('evolution:start', {
      goalId: goal.id,
      description: goal.description,
      soulFileHashes: beforeFp.ok ? beforeFp.value.files : undefined,
    });
  } catch { /* audit chain is non-critical */ }

  // Create safety tag
  const tagResult = await createSafetyTag(goal.id);
  if (!tagResult.ok) {
    return fail(`Cannot create safety checkpoint: ${tagResult.error}`);
  }

  // Create pre-evolution soul snapshot for recovery
  try {
    const { createSnapshot } = await import('../safety/soul-snapshot.js');
    const snapResult = await createSnapshot('pre-evolution');
    if (snapResult.ok) {
      logger.info('pipeline', `Pre-evolution snapshot: ${snapResult.value.id}`);
    } else {
      logger.warn('pipeline', `Pre-evolution snapshot failed (non-fatal): ${snapResult.error}`);
    }
  } catch (err) {
    logger.warn('pipeline', `Pre-evolution snapshot error (non-fatal): ${err}`);
  }

  // Generate pre-evolution identity passport for audit trail
  let preEvolutionPassportHash: string | null = null;
  try {
    const { generateIdentityPassport } = await import('../identity/identity-continuity.js');
    const passportResult = await generateIdentityPassport();
    if (passportResult.ok) {
      preEvolutionPassportHash = passportResult.value.hash;
      logger.info('pipeline', `Pre-evolution passport: ${passportResult.value.hash.slice(0, 12)}...`);

      // Persist for crash recovery
      const { writeFile, mkdir } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const passportDir = join(process.cwd(), 'soul', 'checkpoints', 'passports');
      await mkdir(passportDir, { recursive: true });
      await writeFile(
        join(passportDir, `${goal.id}-pre.json`),
        JSON.stringify(passportResult.value, null, 2),
      );

      await eventBus.emit('identity:passport', {
        action: 'generated',
        hash: passportResult.value.hash,
        context: 'pre-evolution',
      });
    }
  } catch {
    // Passport generation is non-critical
  }

  // Mark goal as in_progress
  startGoal(goal.id);

  // Initialize pipeline state
  await startPipeline(goal.id);

  // Determine starting step (resume if interrupted)
  let startIdx = 0;
  if (hasInterruptedPipeline()) {
    const resumeStep = getResumeStep();
    if (resumeStep) {
      const idx = STEP_ORDER.indexOf(resumeStep);
      if (idx > 0) {
        startIdx = idx;
        logger.info('pipeline', `Resuming from step: ${resumeStep}`);
      }
    }
  }

  const ctx = createContext(goal);

  // Execute steps
  for (let i = startIdx; i < STEP_ORDER.length; i++) {
    const step = STEP_ORDER[i]!;
    const stepFn = STEP_MAP[step];
    if (!stepFn) continue;

    const stepNum = i + 1;
    const total = STEP_ORDER.length;

    try {
      await stepFn(ctx);

      // Research/skill path handled the goal — skip remaining pipeline steps
      if (ctx.earlyExit) {
        logger.info('pipeline', `Early exit after step ${step} — goal handled by alternative path`);
        // For research path, don't count as pipeline success (async completion pending)
        // For skill path, completeGoal was already called
        await cleanupSafetyTag(goal.id);
        return ok('Goal dispatched via alternative path', {
          success: true,
          goalId: goal.id,
          filesChanged: ctx.filesChanged,
          validationReport: undefined,
          requiresRestart: false,
        });
      }

      await advanceStep(ctx.filesChanged.length > 0 ? ctx.filesChanged : undefined);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('pipeline', `Step ${stepNum}/${total} (${step}) failed: ${errorMsg}`);

      await recordPipelineError(errorMsg);

      // Record failure in changelog
      await appendChangelog({
        goalId: goal.id,
        description: goal.description,
        filesChanged: ctx.filesChanged,
        success: false,
        lessonsLearned: `Failed at step ${step}: ${errorMsg}`,
      });

      // Rollback
      logger.warn('pipeline', 'Rolling back...');
      await rollback(goal.id);
      await eventBus.emit('evolution:rollback', { goalId: goal.id, reason: errorMsg });

      // Audit chain — record rollback event
      try {
        const { appendAuditEntry } = await import('../safety/audit-chain.js');
        await appendAuditEntry('evolution:rollback', {
          goalId: goal.id,
          description: goal.description,
          error: errorMsg,
        });
      } catch { /* audit chain is non-critical */ }

      // Update circuit breaker and goal
      recordFailure(errorMsg);
      // Detect which path failed for retry loop prevention
      const failedPath = errorMsg.includes('SKILL path failed') ? 'skill' as const : 'code' as const;
      failGoal(goal.id, errorMsg, failedPath);

      // Record evolution metric for statistical anomaly detection
      try {
        const { recordEvolutionMetric } = await import('./evolution-metrics.js');
        await recordEvolutionMetric({
          timestamp: new Date().toISOString(),
          goalId: goal.id,
          success: false,
          duration: Date.now() - pipelineStartTime,
          failedStep: step,
          filesChanged: ctx.filesChanged.length,
        });
      } catch { /* metrics recording is non-critical */ }

      await clearPipeline();
      await eventBus.emit('evolution:fail', { goalId: goal.id, error: errorMsg });

      // Audit chain — record failed evolution
      try {
        const { appendAuditEntry } = await import('../safety/audit-chain.js');
        await appendAuditEntry('evolution:fail', {
          goalId: goal.id,
          description: goal.description,
          error: errorMsg,
          filesChanged: ctx.filesChanged,
        });
      } catch { /* audit chain is non-critical */ }

      return fail(`Pipeline failed at step ${step}: ${errorMsg}`);
    }
  }

  // ── Post-evolution soul integrity gate ──
  // Verify that critical soul files were NOT modified during evolution.
  // Soul-guard blocks direct writes, but this catches indirect corruption.
  if (preSoulHash) {
    try {
      const { computeSoulFingerprint } = await import('../safety/soul-integrity.js');
      const postFp = await computeSoulFingerprint();
      if (postFp.ok && postFp.value.hash !== preSoulHash) {
        const errorMsg = `Soul integrity violated during evolution: fingerprint changed from ${preSoulHash.slice(0, 12)} to ${postFp.value.hash.slice(0, 12)}`;
        logger.error('pipeline', errorMsg);

        await rollback(goal.id);
        await eventBus.emit('evolution:rollback', { goalId: goal.id, reason: errorMsg });
        recordFailure(errorMsg);
        failGoal(goal.id, errorMsg);
        await clearPipeline();
        return fail(errorMsg);
      }
    } catch {
      // Soul integrity check failure is non-fatal — proceed with success
    }
  }

  // Success!
  recordSuccess();
  completeGoal(goal.id);
  await clearPipeline();
  await eventBus.emit('evolution:success', { goalId: goal.id, description: goal.description });

  // Record evolution metric for statistical anomaly detection
  try {
    const { recordEvolutionMetric } = await import('./evolution-metrics.js');
    await recordEvolutionMetric({
      timestamp: new Date().toISOString(),
      goalId: goal.id,
      success: true,
      duration: Date.now() - pipelineStartTime,
      filesChanged: ctx.filesChanged.length,
    });
  } catch { /* metrics recording is non-critical */ }

  // Audit chain — record successful evolution with Merkle root
  try {
    const { appendAuditEntry, computeMerkleRootFromHashes } = await import('../safety/audit-chain.js');
    const { computeSoulFingerprint } = await import('../safety/soul-integrity.js');
    const fpResult = await computeSoulFingerprint();
    const merkleRoot = fpResult.ok
      ? computeMerkleRootFromHashes(fpResult.value.files) ?? undefined
      : undefined;
    await appendAuditEntry('evolution:success', {
      goalId: goal.id,
      description: goal.description,
      filesChanged: ctx.filesChanged,
      soulFileHashes: fpResult.ok ? fpResult.value.files : undefined,
    }, merkleRoot);
  } catch { /* audit chain is non-critical */ }

  // Verify identity passport after evolution (records delta for audit trail)
  if (preEvolutionPassportHash) {
    try {
      const { readFile, writeFile: writePassportFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const passportPath = join(process.cwd(), 'soul', 'checkpoints', 'passports', `${goal.id}-pre.json`);
      const raw = await readFile(passportPath, 'utf-8');
      const prePassport = JSON.parse(raw);

      const { verifyIdentityPassport } = await import('../identity/identity-continuity.js');
      const verResult = await verifyIdentityPassport(prePassport);

      if (verResult.ok) {
        const { valid, mismatches } = verResult.value;
        logger.info('pipeline',
          `Post-evolution passport: ${valid ? 'UNCHANGED' : 'CHANGED'} — ${mismatches.length} delta(s)`);

        await writePassportFile(
          join(process.cwd(), 'soul', 'checkpoints', 'passports', `${goal.id}-post.json`),
          JSON.stringify({
            prePassportHash: preEvolutionPassportHash,
            verification: verResult.value,
            verifiedAt: new Date().toISOString(),
          }, null, 2),
        );

        await eventBus.emit('identity:passport', {
          action: 'verified',
          hash: preEvolutionPassportHash,
          valid,
          context: 'post-evolution',
        });
      }
    } catch {
      // Passport verification is non-critical
    }
  }

  const requiresRestart = ctx.coreFilesChanged && config.AUTO_RESTART_AFTER_EVOLVE;
  if (requiresRestart) {
    logger.info('pipeline', 'Core files changed, scheduling restart (exit 42)...');
    // Give a moment for cleanup
    setTimeout(() => process.exit(42), 2000);
  }

  logger.info('pipeline', `Evolution pipeline completed successfully for goal ${goal.id}`);

  return ok('Evolution completed', {
    success: true,
    goalId: goal.id,
    filesChanged: ctx.filesChanged,
    validationReport: ctx.validationReport,
    requiresRestart,
  });
}

// ── Module initialization ─────────────────────────────────────────────
// Set up event listeners for async research task tracking
initResearchTaskListeners();
