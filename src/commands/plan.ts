/**
 * /plan command — manage plans with intention-first workflow.
 *
 * Modes:
 *   /plan                    — Show active plans
 *   /plan list               — List recent 5 plans
 *   /plan create             — Guided plan creation prompt
 *   /plan view {id}          — View plan details
 *   /plan step {id} {stepId} — Mark step complete
 *   /plan complete {id}      — Complete a plan
 *   /plan abandon {id}       — Abandon a plan
 *   /plan pipeline [team]    — Visualize team pipeline DAG
 *   /plan help               — Show usage guide
 *
 * Callbacks:
 *   plan:view:{id}           — View details
 *   plan:activate:{id}       — Activate draft
 *   plan:step:{id}:{sid}     — Complete step
 *   plan:complete:{id}       — Complete plan
 *   plan:abandon:{id}        — Abandon plan
 *   plan:list                — Return to list
 *   plan:pipeline:{team}     — View pipeline for team
 */

import { InlineKeyboard } from 'grammy';
import { commandRegistry } from '../telegram/command-registry.js';
import { sendLongMessage } from '../telegram/helpers.js';
import {
  getActivePlans,
  getRecentPlans,
  loadPlan,
  activatePlan,
  completeStep,
  completePlan,
  abandonPlan,
  type Plan,
  type PlanStatus,
} from '../planning/plan-manager.js';
import {
  loadTeamTemplate,
  listTeamNames,
  getParallelStages,
} from '../agents/config/team-config.js';
import type { BotContext } from '../bot.js';

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function statusEmoji(status: PlanStatus): string {
  const map: Record<PlanStatus, string> = {
    draft: '📝',
    active: '▶️',
    completed: '✅',
    abandoned: '❌',
  };
  return map[status] || '📋';
}

function statusLabel(status: PlanStatus): string {
  const map: Record<PlanStatus, string> = {
    draft: '草稿',
    active: '進行中',
    completed: '已完成',
    abandoned: '已放棄',
  };
  return map[status] || status;
}

function progressBar(completed: number, total: number, width = 10): string {
  if (total === 0) return '[ ]';
  const filled = Math.round((completed / total) * width);
  const empty = width - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${completed}/${total}`;
}

function formatPlanOverview(plan: Plan): string {
  const completed = plan.steps.filter((s) => s.completed).length;
  const total = plan.steps.length;
  const emoji = statusEmoji(plan.status);
  const label = statusLabel(plan.status);

  const lines: string[] = [];
  lines.push(`${emoji} ${plan.title}`);
  lines.push(`  狀態：${label}　${progressBar(completed, total)}`);
  if (plan.intention) {
    const intentionPreview = plan.intention.length > 60
      ? plan.intention.slice(0, 57) + '...'
      : plan.intention;
    lines.push(`  意圖：${intentionPreview}`);
  }
  return lines.join('\n');
}

function formatPlanDetail(plan: Plan): string {
  const completed = plan.steps.filter((s) => s.completed).length;
  const total = plan.steps.length;
  const emoji = statusEmoji(plan.status);
  const label = statusLabel(plan.status);

  const lines: string[] = [];
  lines.push(`${emoji} ${plan.title}`);
  lines.push(`狀態：${label}　${progressBar(completed, total, 15)}`);
  lines.push('');

  if (plan.intention) {
    lines.push(`💡 意圖：${plan.intention}`);
  }
  if (plan.approach) {
    lines.push(`🛤️ 方法：${plan.approach}`);
  }
  if (plan.successCriteria) {
    lines.push(`🎯 成功標準：${plan.successCriteria}`);
  }
  lines.push('');

  lines.push('📋 步驟：');
  for (const step of plan.steps) {
    const check = step.completed ? '✅' : '⬜';
    lines.push(`  ${check} ${step.id}. ${step.description}`);
    if (step.notes) {
      lines.push(`     📝 ${step.notes}`);
    }
  }
  lines.push('');

  lines.push(`建立於：${plan.createdAt.slice(0, 10)}`);
  if (plan.startedAt) {
    lines.push(`啟動於：${plan.startedAt.slice(0, 10)}`);
  }
  if (plan.completedAt) {
    lines.push(`結束於：${plan.completedAt.slice(0, 10)}`);
  }

  if (plan.retrospective) {
    lines.push('');
    lines.push(`📖 回顧：${plan.retrospective}`);
  }
  if (plan.lessonsLearned) {
    lines.push(`💡 教訓：${plan.lessonsLearned}`);
  }
  if (plan.satisfactionLevel) {
    lines.push(`⭐ 滿意度：${'★'.repeat(plan.satisfactionLevel)}${'☆'.repeat(5 - plan.satisfactionLevel)}`);
  }

  return lines.join('\n');
}

function buildPlanKeyboard(plan: Plan): InlineKeyboard {
  const kb = new InlineKeyboard();

  switch (plan.status) {
    case 'draft':
      kb.text('▶️ 啟動', `plan:activate:${plan.id}`)
        .text('❌ 放棄', `plan:abandon:${plan.id}`);
      break;

    case 'active': {
      // One button per incomplete step
      const incomplete = plan.steps.filter((s) => !s.completed);
      for (const step of incomplete) {
        kb.text(
          `⬜ ${step.id}. ${step.description.slice(0, 20)}`,
          `plan:step:${plan.id}:${step.id}`,
        ).row();
      }
      kb.text('✅ 完成計劃', `plan:complete:${plan.id}`)
        .text('❌ 放棄', `plan:abandon:${plan.id}`);
      break;
    }

    case 'completed':
    case 'abandoned':
      kb.text('📋 返回列表', 'plan:list');
      break;
  }

  return kb;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** /plan (no args) — show active plans */
async function handlePlanDefault(ctx: BotContext): Promise<void> {
  const plans = await getActivePlans();

  if (plans.length === 0) {
    const keyboard = new InlineKeyboard()
      .text('📋 查看歷史計劃', 'plan:list');

    await ctx.reply('目前沒有進行中的計劃。', { reply_markup: keyboard });
    return;
  }

  const lines: string[] = [`📋 進行中的計劃（${plans.length} 個）`, ''];
  const keyboard = new InlineKeyboard();

  for (const plan of plans) {
    lines.push(formatPlanOverview(plan));
    lines.push('');
    keyboard.text(`${statusEmoji(plan.status)} ${plan.title.slice(0, 25)}`, `plan:view:${plan.id}`).row();
  }

  await sendLongMessage(ctx, ctx.chat!.id, lines.join('\n'));
  await ctx.reply('點選查看詳情：', { reply_markup: keyboard });
}

/** /plan list — list recent plans */
async function handlePlanList(ctx: BotContext): Promise<void> {
  const plans = await getRecentPlans(5);

  if (plans.length === 0) {
    await ctx.reply('還沒有任何計劃。');
    return;
  }

  const lines: string[] = [`📋 最近的計劃（${plans.length} 個）`, ''];
  const keyboard = new InlineKeyboard();

  for (const plan of plans) {
    lines.push(formatPlanOverview(plan));
    lines.push('');
    keyboard.text(`${statusEmoji(plan.status)} ${plan.title.slice(0, 25)}`, `plan:view:${plan.id}`).row();
  }

  await sendLongMessage(ctx, ctx.chat!.id, lines.join('\n'));
  await ctx.reply('點選查看詳情：', { reply_markup: keyboard });
}

/** /plan view {id} — view plan details */
async function handlePlanView(ctx: BotContext, planId: string): Promise<void> {
  const plan = await loadPlan(planId);

  if (!plan) {
    await ctx.reply(`找不到計劃 ${planId}。`);
    return;
  }

  const text = formatPlanDetail(plan);
  const keyboard = buildPlanKeyboard(plan);

  await sendLongMessage(ctx, ctx.chat!.id, text);
  await ctx.reply('操作：', { reply_markup: keyboard });
}

/** /plan step {id} {stepId} — mark step complete */
async function handlePlanStep(ctx: BotContext, planId: string, stepId: number): Promise<void> {
  const result = await completeStep(planId, stepId);

  if (!result.ok) {
    await ctx.reply(`操作失敗：${result.error}`);
    return;
  }

  const plan = result.value;
  const step = plan.steps.find((s) => s.id === stepId);
  await ctx.reply(`✅ 已完成步驟 ${stepId}：${step?.description || ''}`);

  // Re-show plan detail
  const text = formatPlanDetail(plan);
  const keyboard = buildPlanKeyboard(plan);
  await sendLongMessage(ctx, ctx.chat!.id, text);
  await ctx.reply('操作：', { reply_markup: keyboard });
}

/** /plan complete {id} — complete a plan */
async function handlePlanComplete(ctx: BotContext, planId: string): Promise<void> {
  const result = await completePlan(planId, '手動完成', '', 4);

  if (!result.ok) {
    await ctx.reply(`操作失敗：${result.error}`);
    return;
  }

  const plan = result.value;
  await ctx.reply(`✅ 計劃「${plan.title}」已完成！`);

  const text = formatPlanDetail(plan);
  const keyboard = buildPlanKeyboard(plan);
  await sendLongMessage(ctx, ctx.chat!.id, text);
  await ctx.reply('操作：', { reply_markup: keyboard });
}

/** /plan abandon {id} — abandon a plan */
async function handlePlanAbandon(ctx: BotContext, planId: string): Promise<void> {
  const result = await abandonPlan(planId, '手動放棄');

  if (!result.ok) {
    await ctx.reply(`操作失敗：${result.error}`);
    return;
  }

  const plan = result.value;
  await ctx.reply(`❌ 計劃「${plan.title}」已放棄。`);

  const text = formatPlanDetail(plan);
  const keyboard = buildPlanKeyboard(plan);
  await sendLongMessage(ctx, ctx.chat!.id, text);
  await ctx.reply('操作：', { reply_markup: keyboard });
}

/** /plan create — show guided creation prompt */
async function handlePlanCreate(ctx: BotContext): Promise<void> {
  const guide = [
    '📋 建立新計劃',
    '',
    '請用以下格式告訴我你的計劃：',
    '',
    '標題：（計劃名稱）',
    '意圖：（為什麼要做這件事？）',
    '方法：（打算怎麼做？）',
    '步驟：',
    '1. （第一步）',
    '2. （第二步）',
    '3. （第三步）',
    '成功標準：（怎樣算完成？）',
    '',
    '你可以直接用自然語言描述，我會幫你整理成計劃。',
  ].join('\n');

  await ctx.reply(guide);
}

/** /plan help — show usage guide */
async function handlePlanHelp(ctx: BotContext): Promise<void> {
  const guide = [
    '📋 /plan 使用指南',
    '',
    '管理意圖優先（Intention-First）的計劃。',
    '每個計劃包含三層：意圖（Why）→ 方法（How）→ 步驟（What）。',
    '',
    '指令：',
    '  /plan             查看進行中的計劃',
    '  /plan list        最近 5 個計劃',
    '  /plan create      建立新計劃（引導模式）',
    '  /plan view {id}   查看計劃詳情',
    '  /plan step {id} {stepId}  完成一個步驟',
    '  /plan complete {id}       標記計劃完成',
    '  /plan abandon {id}        放棄計劃',
    '  /plan pipeline [team]     查看團隊管線 DAG',
    '  /plan help                顯示此說明',
    '',
    '範例：',
    '  /plan pipeline content-pipeline',
    '  /plan view a1b2c3d4',
  ].join('\n');

  await ctx.reply(guide);
}

/** /plan pipeline [team] — visualize team pipeline DAG */
async function handlePlanPipeline(ctx: BotContext, teamName?: string): Promise<void> {
  // If no team specified, list available teams
  if (!teamName) {
    const names = await listTeamNames();
    if (names.length === 0) {
      await ctx.reply('沒有找到任何團隊模板。');
      return;
    }

    const lines = ['📋 可用的團隊管線：', ''];
    const keyboard = new InlineKeyboard();
    for (const name of names) {
      const template = await loadTeamTemplate(name);
      if (!template) continue;
      const stageCount = template.workflow.stages.length;
      lines.push(`  ${name} — ${template.description.slice(0, 40)} (${stageCount} 階段)`);
      keyboard.text(name, `plan:pipeline:${name}`).row();
    }
    lines.push('');
    lines.push('點選或輸入 /plan pipeline {name} 查看 DAG：');

    await sendLongMessage(ctx, ctx.chat!.id, lines.join('\n'));
    await ctx.reply('選擇團隊：', { reply_markup: keyboard });
    return;
  }

  const template = await loadTeamTemplate(teamName);
  if (!template) {
    await ctx.reply(`找不到團隊模板：${teamName}`);
    return;
  }

  // Build DAG visualization
  const layers = getParallelStages(template);
  const budget = template.workflow.contextTokenBudget;

  const lines: string[] = [];
  lines.push(`📋 管線計畫：${template.name}`);
  lines.push(`${template.description}`);
  lines.push('');

  // Budget info
  lines.push(`💰 預算上限：$${template.budget.maxTotalCostUsd.toFixed(2)}`);
  if (budget) {
    lines.push(`📊 上下文 Token 預算：${budget}`);
  }
  lines.push(`⚙️ 失敗策略：${template.governance.escalateOnFailure}`);
  lines.push('');

  // DAG visualization
  lines.push('── 管線 DAG ──');
  lines.push('');

  for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
    const layer = layers[layerIdx]!;
    const isLast = layerIdx === layers.length - 1;

    if (layer.length === 1) {
      // Single stage
      const s = layer[0]!;
      const filter = s.inputFilter ?? 'token-budget';
      const limit = template.budget.perStageLimits?.[s.id];
      const member = template.members.find(m => m.agentName === s.agentName);
      const role = member?.teamRole ?? '';

      lines.push(`  ┌─ ${s.id} ─────────────┐`);
      lines.push(`  │ ${s.agentName} (${role})`);
      if (limit) lines.push(`  │ 💰 $${limit.toFixed(2)}`);
      lines.push(`  │ 📥 ${filter}`);
      if (s.optional) lines.push(`  │ ⚠️ optional`);
      lines.push(`  └──────────────────────┘`);
    } else {
      // Parallel stages
      lines.push('  ┌── parallel ──────────┐');
      for (const s of layer) {
        const filter = s.inputFilter ?? 'token-budget';
        const limit = template.budget.perStageLimits?.[s.id];
        const member = template.members.find(m => m.agentName === s.agentName);
        const role = member?.teamRole ?? '';

        lines.push(`  │ ┌ ${s.id} ──────────┐`);
        lines.push(`  │ │ ${s.agentName} (${role})`);
        if (limit) lines.push(`  │ │ 💰 $${limit.toFixed(2)}`);
        lines.push(`  │ │ 📥 ${filter}`);
        if (s.optional) lines.push(`  │ │ ⚠️ optional`);
        lines.push(`  │ └───────────────┘`);
      }
      lines.push('  └────────────────────────┘');
    }

    if (!isLast) {
      lines.push('          │');
      lines.push('          ▼');
    }
  }

  lines.push('');

  // Member summary
  lines.push('── 成員 ──');
  for (const m of template.members) {
    lines.push(`  ${m.teamRole}: ${m.agentName}`);
    lines.push(`    目標：${m.goal.slice(0, 60)}`);
  }

  await sendLongMessage(ctx, ctx.chat!.id, lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerPlanCommand(): void {
  commandRegistry.registerCommand({
    name: 'plan',
    description: '管理計劃',
    aliases: ['計劃', '規劃'],
    handler: async (ctx) => {
      const text = ctx.message?.text || '';
      const args = text.replace(/^\/plan\s*/, '').trim();

      if (!args) {
        await handlePlanDefault(ctx);
      } else if (args === 'help') {
        await handlePlanHelp(ctx);
      } else if (args === 'list') {
        await handlePlanList(ctx);
      } else if (args === 'create') {
        await handlePlanCreate(ctx);
      } else if (args === 'pipeline' || args.startsWith('pipeline ')) {
        const teamName = args.slice(9).trim() || undefined;
        await handlePlanPipeline(ctx, teamName);
      } else if (args.startsWith('view ')) {
        const planId = args.slice(5).trim();
        await handlePlanView(ctx, planId);
      } else if (args === 'step' || args.startsWith('step ')) {
        const parts = args.slice(5).trim().split(/\s+/);
        const planId = parts[0];
        const stepId = parseInt(parts[1] || '', 10);
        if (!planId || isNaN(stepId)) {
          await ctx.reply('用法：/plan step {planId} {stepId}');
          return;
        }
        await handlePlanStep(ctx, planId, stepId);
      } else if (args.startsWith('complete ')) {
        const planId = args.slice(9).trim();
        await handlePlanComplete(ctx, planId);
      } else if (args.startsWith('abandon ')) {
        const planId = args.slice(8).trim();
        await handlePlanAbandon(ctx, planId);
      } else {
        await handlePlanDefault(ctx);
      }
    },
  });

  // Callback handlers
  commandRegistry.registerCallback('plan:view:', async (ctx, data) => {
    await handlePlanView(ctx, data);
  });

  commandRegistry.registerCallback('plan:activate:', async (ctx, data) => {
    const result = await activatePlan(data);
    if (!result.ok) {
      await ctx.reply(`啟動失敗：${result.error}`);
      return;
    }
    await ctx.reply(`▶️ 計劃「${result.value.title}」已啟動！`);
    await handlePlanView(ctx, data);
  });

  commandRegistry.registerCallback('plan:step:', async (ctx, data) => {
    // data format: {planId}:{stepId}
    const colonIdx = data.lastIndexOf(':');
    if (colonIdx === -1) {
      await ctx.reply('無效的步驟操作。');
      return;
    }
    const planId = data.slice(0, colonIdx);
    const stepId = parseInt(data.slice(colonIdx + 1), 10);
    if (isNaN(stepId)) {
      await ctx.reply('無效的步驟編號。');
      return;
    }
    await handlePlanStep(ctx, planId, stepId);
  });

  commandRegistry.registerCallback('plan:complete:', async (ctx, data) => {
    await handlePlanComplete(ctx, data);
  });

  commandRegistry.registerCallback('plan:abandon:', async (ctx, data) => {
    await handlePlanAbandon(ctx, data);
  });

  commandRegistry.registerCallback('plan:list', async (ctx, _data) => {
    await handlePlanList(ctx);
  });

  commandRegistry.registerCallback('plan:pipeline:', async (ctx, data) => {
    await handlePlanPipeline(ctx, data);
  });
}
