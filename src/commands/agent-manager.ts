/**
 * /agents command — interactive agent management via inline keyboards.
 *
 * Provides:
 *   - Agent list with status overview
 *   - Schedule editing (agent + proactive)
 *   - Budget editing (daily limit + per-task limit)
 *   - Enable/disable toggle
 *
 * Callback data format:
 *   agm:home              — management home
 *   agm:list              — agent list
 *   agm:d:NAME            — agent detail
 *   agm:s:NAME            — edit schedule screen
 *   agm:sv:NAME:VAL       — set schedule value
 *   agm:b:NAME            — edit daily budget screen
 *   agm:bv:NAME:VAL       — set daily budget value
 *   agm:t:NAME            — edit task budget screen
 *   agm:tv:NAME:VAL       — set task budget value
 *   agm:tog:NAME          — toggle enabled/disabled
 *   agm:ps                — proactive schedule list
 *   agm:pt:KEY            — edit proactive time screen
 *   agm:ptv:KEY:TIME      — set proactive time value
 */

import { InlineKeyboard } from 'grammy';
import { commandRegistry, registerParentCommand } from '../telegram/command-registry.js';
import { handlePipeline } from './pipeline.js';
import {
  loadAllAgentConfigs,
  loadAgentConfig,
  saveAgentConfig,
} from '../agents/config/agent-config.js';
import { scheduleEngine } from '../core/schedule-engine.js';
import { logger } from '../core/logger.js';
import type { BotContext } from '../bot.js';

// ── Constants ─────────────────────────────────────────────────────────

/** Schedule presets: [callbackValue, displayLabel, cronExpr] */
const SCHEDULE_PRESETS: [string, string, string][] = [
  ['m', '手動', 'manual'],
  ['30m', '每30分鐘', 'every:30m'],
  ['1h', '每1小時', 'every:1h'],
  ['2h', '每2小時', 'every:2h'],
  ['4h', '每4小時', 'every:4h'],
  ['6h', '每6小時', 'every:6h'],
  ['12h', '每12小時', 'every:12h'],
  ['24h', '每24小時', 'every:24h'],
  ['d06', '每日 06:00', 'daily@06:00'],
  ['d08', '每日 08:00', 'daily@08:00'],
  ['d09', '每日 09:00', 'daily@09:00'],
  ['d12', '每日 12:00', 'daily@12:00'],
  ['d15', '每日 15:00', 'daily@15:00'],
  ['d18', '每日 18:00', 'daily@18:00'],
  ['d20', '每日 20:00', 'daily@20:00'],
  ['d2030', '每日 20:30', 'daily@20:30'],
  ['d21', '每日 21:00', 'daily@21:00'],
  ['d2130', '每日 21:30', 'daily@21:30'],
  ['d23', '每日 23:00', 'daily@23:00'],
];

/** Budget presets in USD */
const BUDGET_PRESETS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

/** Task budget presets in USD */
const TASK_BUDGET_PRESETS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

/** Proactive schedule short keys → { id, label, icon } */
const PROACTIVE_MAP: Record<string, { id: string; label: string; icon: string }> = {
  pg: { id: 'proactive:greeting', label: '問候', icon: '☀️' },
  pm: { id: 'proactive:morning-channel', label: '晨報', icon: '📰' },
  pc: { id: 'proactive:care', label: '關懷', icon: '💚' },
  pr: { id: 'proactive:reflection', label: '反思', icon: '🌙' },
  pb: { id: 'proactive:blog-writing', label: '寫作', icon: '✏️' },
  pu: { id: 'upgrade-advisor-check', label: '升級檢查', icon: '🔧' },
};


/** GitHub owner for patrol repos */
const GITHUB_OWNER = 'arc119226';

/** Fetch all repos for the owner from GitHub, returns short names */
async function fetchOwnerRepos(): Promise<string[]> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);

  try {
    const { stdout } = await execFileAsync('gh', [
      'repo', 'list', GITHUB_OWNER,
      '--json', 'name',
      '--limit', '100',
    ], { timeout: 15000 });
    const repos = JSON.parse(stdout) as { name: string }[];
    return repos.map((r) => r.name).sort();
  } catch (err) {
    logger.warn('AgentManager', 'Failed to fetch repos from GitHub', err);
    return [];
  }
}

/** Time presets for proactive schedules (HH:MM) */
const TIME_PRESETS = [
  '06:00', '07:00', '08:00', '08:30', '09:00', '09:30', '10:00',
  '12:00', '14:00', '15:00', '16:00', '18:00',
  '20:00', '20:30', '21:00', '21:30', '22:00', '23:00',
];

// ── Helpers ───────────────────────────────────────────────────────────

function scheduleToDisplay(schedule: string): string {
  const preset = SCHEDULE_PRESETS.find(([, , expr]) => expr === schedule);
  if (preset) return preset[1];
  return schedule;
}

function shortToSchedule(short: string): string | null {
  const preset = SCHEDULE_PRESETS.find(([val]) => val === short);
  return preset ? preset[2] : null;
}

/** Edit the existing message, or send a new one if editing fails. */
async function editOrReply(
  ctx: BotContext,
  text: string,
  keyboard: InlineKeyboard,
): Promise<void> {
  try {
    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
  } catch {
    try {
      await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
    } catch {
      await ctx.reply(text.replace(/[*_`[\]]/g, ''), { reply_markup: keyboard });
    }
  }
}

// ── Screens ──────────────────────────────────────────────────────────

async function showHome(ctx: BotContext): Promise<void> {
  const configs = await loadAllAgentConfigs();
  const active = configs.filter((c) => c.enabled).length;
  const todayCost = configs.reduce((sum, c) => sum + (c.totalCostToday ?? 0), 0);

  const text = [
    '🤖 *Agent 管理*',
    '',
    `Active: ${active} / Total: ${configs.length}`,
    `今日總花費: $${todayCost.toFixed(2)}`,
  ].join('\n');

  const kb = new InlineKeyboard()
    .text('📋 Agent 列表', 'agm:list')
    .text('⏰ 排程一覽', 'agm:ps')
    .row()
    .text('◀️ 返回選單', 'menu:home');

  await editOrReply(ctx, text, kb);
}

async function showAgentList(ctx: BotContext): Promise<void> {
  const configs = await loadAllAgentConfigs();
  configs.sort((a, b) => a.name.localeCompare(b.name));

  const lines = ['📋 *Agent 列表*', ''];
  for (const cfg of configs) {
    const icon = cfg.enabled ? '🟢' : '🔴';
    const sched = scheduleToDisplay(cfg.schedule);
    const budget = cfg.dailyCostLimit > 0 ? `$${cfg.dailyCostLimit}` : '無限';
    lines.push(`${icon} *${cfg.name}* — ${sched}, ${budget}/日`);
  }

  const kb = new InlineKeyboard();
  for (let i = 0; i < configs.length; i += 2) {
    if (i > 0) kb.row();
    kb.text(configs[i]!.name, `agm:d:${configs[i]!.name}`);
    if (configs[i + 1]) {
      kb.text(configs[i + 1]!.name, `agm:d:${configs[i + 1]!.name}`);
    }
  }
  kb.row().text('◀️ 返回', 'agm:home');

  await editOrReply(ctx, lines.join('\n'), kb);
}

async function showAgentDetail(ctx: BotContext, name: string): Promise<void> {
  const cfg = await loadAgentConfig(name);
  if (!cfg) {
    await ctx.answerCallbackQuery({ text: `Agent "${name}" 不存在` });
    return;
  }

  const statusIcon = cfg.enabled ? '🟢 啟用' : '🔴 停用';
  const sched = scheduleToDisplay(cfg.schedule);
  const budget = cfg.dailyCostLimit > 0 ? `$${cfg.dailyCostLimit.toFixed(2)}` : '無限';
  const taskBudget = (cfg.maxCostPerTask ?? 0) > 0 ? `$${cfg.maxCostPerTask!.toFixed(2)}` : '無限';
  const todayCost = cfg.totalCostToday ?? 0;
  const overBudget = cfg.dailyCostLimit > 0 && todayCost >= cfg.dailyCostLimit;

  const lines = [
    `🤖 *${cfg.name}*`,
    cfg.description ? `📝 ${cfg.description.slice(0, 60)}` : '',
    `📊 ${statusIcon}`,
    '',
    `⏰ 排程：${sched}`,
    `💰 日預算：${budget}`,
    `💰 單任務上限：${taskBudget}`,
    `📈 今日：$${todayCost.toFixed(2)}${cfg.dailyCostLimit > 0 ? ` / $${cfg.dailyCostLimit.toFixed(2)}` : ''}${overBudget ? ' (超額!)' : ''}`,
    `🔄 已執行：${cfg.totalRuns} 次`,
  ].filter(Boolean);

  const toggleLabel = cfg.enabled ? '🔴 停用' : '🟢 啟用';

  const kb = new InlineKeyboard()
    .text('⏰ 改排程', `agm:s:${name}`)
    .text('💰 改日預算', `agm:b:${name}`)
    .row()
    .text('💰 改單任務', `agm:t:${name}`)
    .text(toggleLabel, `agm:tog:${name}`);

  // Show repo management button for agents with targets.repos
  const hasRepos = Array.isArray(cfg.targets?.repos);
  if (hasRepos) {
    const repoCount = (cfg.targets.repos as string[]).length;
    lines.push(`📦 巡檢 Repos：${repoCount} 個`);
    kb.row().text('📦 巡檢 Repos', `agm:rp:${name}`);
  }

  kb.row().text('◀️ 返回列表', 'agm:list');

  await editOrReply(ctx, lines.join('\n'), kb);
}

async function showScheduleEdit(ctx: BotContext, name: string): Promise<void> {
  const cfg = await loadAgentConfig(name);
  if (!cfg) return;

  const current = scheduleToDisplay(cfg.schedule);
  const text = [
    `⏰ *修改排程：${name}*`,
    `目前：${current}`,
    '',
    '選擇新排程：',
  ].join('\n');

  const kb = new InlineKeyboard();
  for (let i = 0; i < SCHEDULE_PRESETS.length; i += 3) {
    if (i > 0) kb.row();
    for (let j = i; j < Math.min(i + 3, SCHEDULE_PRESETS.length); j++) {
      const [val, label] = SCHEDULE_PRESETS[j]!;
      kb.text(label, `agm:sv:${name}:${val}`);
    }
  }
  kb.row().text('◀️ 返回', `agm:d:${name}`);

  await editOrReply(ctx, text, kb);
}

async function showBudgetEdit(ctx: BotContext, name: string): Promise<void> {
  const cfg = await loadAgentConfig(name);
  if (!cfg) return;

  const current = cfg.dailyCostLimit > 0 ? `$${cfg.dailyCostLimit.toFixed(2)}` : '無限';
  const text = [
    `💰 *修改日預算：${name}*`,
    `目前：${current}`,
    '',
    '選擇新預算：',
  ].join('\n');

  const kb = new InlineKeyboard();
  for (let i = 0; i < BUDGET_PRESETS.length; i += 2) {
    if (i > 0) kb.row();
    kb.text(`$${BUDGET_PRESETS[i]!}`, `agm:bv:${name}:${BUDGET_PRESETS[i]!}`);
    if (BUDGET_PRESETS[i + 1] !== undefined) {
      kb.text(`$${BUDGET_PRESETS[i + 1]!}`, `agm:bv:${name}:${BUDGET_PRESETS[i + 1]!}`);
    }
  }
  kb.row().text('◀️ 返回', `agm:d:${name}`);

  await editOrReply(ctx, text, kb);
}

async function showTaskBudgetEdit(ctx: BotContext, name: string): Promise<void> {
  const cfg = await loadAgentConfig(name);
  if (!cfg) return;

  const current = (cfg.maxCostPerTask ?? 0) > 0 ? `$${cfg.maxCostPerTask!.toFixed(2)}` : '無限';
  const text = [
    `💰 *修改單任務上限：${name}*`,
    `目前：${current}`,
    '',
    '選擇新上限：',
  ].join('\n');

  const kb = new InlineKeyboard();
  for (let i = 0; i < TASK_BUDGET_PRESETS.length; i += 2) {
    if (i > 0) kb.row();
    kb.text(`$${TASK_BUDGET_PRESETS[i]!}`, `agm:tv:${name}:${TASK_BUDGET_PRESETS[i]!}`);
    if (TASK_BUDGET_PRESETS[i + 1] !== undefined) {
      kb.text(`$${TASK_BUDGET_PRESETS[i + 1]!}`, `agm:tv:${name}:${TASK_BUDGET_PRESETS[i + 1]!}`);
    }
  }
  kb.row().text('◀️ 返回', `agm:d:${name}`);

  await editOrReply(ctx, text, kb);
}

async function showProactiveList(ctx: BotContext): Promise<void> {
  const active = scheduleEngine.getBySource('proactive');

  const lines = ['⏰ *主動排程一覽*', ''];
  for (const meta of Object.values(PROACTIVE_MAP)) {
    const entry = active.find((s) => s.id === meta.id);
    const time = entry ? entry.cronExpr.replace('daily@', '') : '未排程';
    lines.push(`${meta.icon} ${meta.label} — ${time}`);
  }

  const kb = new InlineKeyboard();
  const keys = Object.keys(PROACTIVE_MAP);
  for (let i = 0; i < keys.length; i += 3) {
    if (i > 0) kb.row();
    for (let j = i; j < Math.min(i + 3, keys.length); j++) {
      const k = keys[j]!;
      const meta = PROACTIVE_MAP[k]!;
      kb.text(`${meta.icon} ${meta.label}`, `agm:pt:${k}`);
    }
  }
  kb.row().text('◀️ 返回', 'agm:home');

  await editOrReply(ctx, lines.join('\n'), kb);
}

async function showProactiveTimeEdit(ctx: BotContext, key: string): Promise<void> {
  const meta = PROACTIVE_MAP[key];
  if (!meta) return;

  const active = scheduleEngine.getBySource('proactive');
  const entry = active.find((s) => s.id === meta.id);
  const current = entry ? entry.cronExpr.replace('daily@', '') : '未排程';

  const text = [
    `⏰ *修改時間：${meta.icon} ${meta.label}*`,
    `目前：${current}`,
    '',
    '選擇新時間：',
  ].join('\n');

  const kb = new InlineKeyboard();
  for (let i = 0; i < TIME_PRESETS.length; i += 3) {
    if (i > 0) kb.row();
    for (let j = i; j < Math.min(i + 3, TIME_PRESETS.length); j++) {
      const t = TIME_PRESETS[j]!;
      kb.text(t, `agm:ptv:${key}:${t}`);
    }
  }
  kb.row().text('◀️ 返回', 'agm:ps');

  await editOrReply(ctx, text, kb);
}

// ── Mutation handlers ────────────────────────────────────────────────

async function setAgentSchedule(ctx: BotContext, name: string, shortVal: string): Promise<void> {
  const cronExpr = shortToSchedule(shortVal);
  if (!cronExpr) {
    await ctx.answerCallbackQuery({ text: '無效的排程值' });
    return;
  }

  const cfg = await loadAgentConfig(name);
  if (!cfg) return;

  cfg.schedule = cronExpr;
  await saveAgentConfig(cfg);
  await logger.info('AgentManager', `Schedule updated: ${name} → ${cronExpr}`);

  await showAgentDetail(ctx, name);
}

async function setAgentBudget(ctx: BotContext, name: string, value: string): Promise<void> {
  const amount = parseFloat(value);
  if (isNaN(amount) || amount < 0) {
    await ctx.answerCallbackQuery({ text: '無效的金額' });
    return;
  }

  const cfg = await loadAgentConfig(name);
  if (!cfg) return;

  cfg.dailyCostLimit = amount;
  await saveAgentConfig(cfg);
  await logger.info('AgentManager', `Daily budget updated: ${name} → $${amount}`);

  await showAgentDetail(ctx, name);
}

async function setAgentTaskBudget(ctx: BotContext, name: string, value: string): Promise<void> {
  const amount = parseFloat(value);
  if (isNaN(amount) || amount < 0) {
    await ctx.answerCallbackQuery({ text: '無效的金額' });
    return;
  }

  const cfg = await loadAgentConfig(name);
  if (!cfg) return;

  cfg.maxCostPerTask = amount;
  await saveAgentConfig(cfg);
  await logger.info('AgentManager', `Task budget updated: ${name} → $${amount}`);

  await showAgentDetail(ctx, name);
}

async function toggleAgent(ctx: BotContext, name: string): Promise<void> {
  const cfg = await loadAgentConfig(name);
  if (!cfg) return;

  cfg.enabled = !cfg.enabled;
  await saveAgentConfig(cfg);
  const state = cfg.enabled ? '啟用' : '停用';
  await logger.info('AgentManager', `Agent toggled: ${name} → ${state}`);

  await showAgentDetail(ctx, name);
}

async function setProactiveTime(ctx: BotContext, key: string, time: string): Promise<void> {
  const meta = PROACTIVE_MAP[key];
  if (!meta) return;

  // Validate HH:MM format
  if (!/^\d{2}:\d{2}$/.test(time)) {
    await ctx.answerCallbackQuery({ text: '無效的時間格式' });
    return;
  }

  try {
    // Dynamic import to avoid circular dependency at module level
    const { rescheduleProactive } = await import('../proactive/engine.js');
    rescheduleProactive(meta.id, `daily@${time}`);
    await logger.info('AgentManager', `Proactive schedule updated: ${meta.id} → daily@${time}`);
  } catch (err) {
    await logger.error('AgentManager', `Failed to reschedule ${meta.id}`, err);
    await ctx.answerCallbackQuery({ text: '排程更新失敗' });
    return;
  }

  await showProactiveList(ctx);
}

// ── Repo management screens ─────────────────────────────────────────

async function showRepoList(ctx: BotContext, agentName: string): Promise<void> {
  const cfg = await loadAgentConfig(agentName);
  if (!cfg) return;

  const repos = (cfg.targets?.repos as string[]) ?? [];

  const lines = [`📦 *${agentName} — 巡檢 Repo 列表*`, ''];
  for (const repo of repos) {
    lines.push(`• \`${repo}\``);
  }
  if (repos.length === 0) {
    lines.push('_(無 repo)_');
  }

  const kb = new InlineKeyboard();
  for (const repo of repos) {
    const shortName = repo.split('/')[1] ?? repo;
    kb.row().text(`🗑️ 移除 ${shortName}`, `agm:rpd:${agentName}:${shortName}`);
  }
  kb.row().text('➕ 新增 Repo', `agm:rpa:${agentName}`);
  kb.row().text(`◀️ 返回 ${agentName}`, `agm:d:${agentName}`);

  await editOrReply(ctx, lines.join('\n'), kb);
}

async function showAddRepo(ctx: BotContext, agentName: string): Promise<void> {
  const cfg = await loadAgentConfig(agentName);
  if (!cfg) return;

  const currentRepos = ((cfg.targets?.repos as string[]) ?? [])
    .map((r) => r.split('/')[1] ?? r);

  const allRepos = await fetchOwnerRepos();
  if (allRepos.length === 0) {
    const text = '➕ *新增 Repo*\n\n無法取得 GitHub repo 列表，請確認 `gh` CLI 已登入。';
    const kb = new InlineKeyboard().text('◀️ 返回', `agm:rp:${agentName}`);
    await editOrReply(ctx, text, kb);
    return;
  }

  const available = allRepos.filter((r) => !currentRepos.includes(r));

  if (available.length === 0) {
    const text = '➕ *新增 Repo*\n\n所有 repo 都已加入巡檢清單。';
    const kb = new InlineKeyboard().text('◀️ 返回', `agm:rp:${agentName}`);
    await editOrReply(ctx, text, kb);
    return;
  }

  const text = '➕ *新增 Repo*\n\n選擇要加入巡檢的 repo：';
  const kb = new InlineKeyboard();
  for (let i = 0; i < available.length; i += 2) {
    if (i > 0) kb.row();
    kb.text(available[i]!, `agm:rpav:${agentName}:${available[i]!}`);
    if (available[i + 1]) {
      kb.text(available[i + 1]!, `agm:rpav:${agentName}:${available[i + 1]!}`);
    }
  }
  kb.row().text('◀️ 返回', `agm:rp:${agentName}`);

  await editOrReply(ctx, text, kb);
}

async function removeRepo(ctx: BotContext, agentName: string, repoName: string): Promise<void> {
  const cfg = await loadAgentConfig(agentName);
  if (!cfg) return;

  const repos = (cfg.targets?.repos as string[]) ?? [];
  const fullName = `${GITHUB_OWNER}/${repoName}`;
  cfg.targets.repos = repos.filter((r) => r !== fullName);
  await saveAgentConfig(cfg);
  await logger.info('AgentManager', `Repo removed from ${agentName}: ${fullName}`);

  await showRepoList(ctx, agentName);
}

async function addRepo(ctx: BotContext, agentName: string, repoName: string): Promise<void> {
  const cfg = await loadAgentConfig(agentName);
  if (!cfg) return;

  const repos = (cfg.targets?.repos as string[]) ?? [];
  const fullName = `${GITHUB_OWNER}/${repoName}`;
  if (!repos.includes(fullName)) {
    repos.push(fullName);
    cfg.targets.repos = repos;
    await saveAgentConfig(cfg);
    await logger.info('AgentManager', `Repo added to ${agentName}: ${fullName}`);
  }

  await showRepoList(ctx, agentName);
}

// ── Registration ─────────────────────────────────────────────────────

async function handleGhPatrol(ctx: BotContext): Promise<void> {
  const cfg = await loadAgentConfig('github-patrol');
  if (!cfg) {
    await ctx.reply('GitHub Patrol agent 不存在。');
    return;
  }

  const repos = (cfg.targets?.repos as string[]) ?? [];
  const lines = [`📦 *GitHub Patrol — 巡檢 Repo 列表*`, ''];
  for (const repo of repos) {
    lines.push(`• \`${repo}\``);
  }
  if (repos.length === 0) {
    lines.push('_(無 repo)_');
  }

  const kb = new InlineKeyboard();
  for (const repo of repos) {
    const shortName = repo.split('/')[1] ?? repo;
    kb.row().text(`🗑️ 移除 ${shortName}`, `agm:rpd:github-patrol:${shortName}`);
  }
  kb.row().text('➕ 新增 Repo', 'agm:rpa:github-patrol');
  kb.row().text('◀️ 返回選單', 'menu:home');

  try {
    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown', reply_markup: kb });
  } catch {
    await ctx.reply(lines.join('\n').replace(/[*_`[\]]/g, ''), { reply_markup: kb });
  }
}

export function registerAgentManagerCommand(): void {
  registerParentCommand({
    name: 'agents',
    description: 'Agent 排程與預算管理',
    aliases: ['agent管理', 'agentmgr'],
    adminOnly: true,
    subcommands: [
      { name: 'pipeline', aliases: ['pipe', '管線'], description: '啟動 Pipeline', handler: handlePipeline },
      { name: 'ghpatrol', aliases: ['巡檢'], description: 'GitHub 巡檢', handler: handleGhPatrol },
    ],
    defaultHandler: async (ctx) => {
      const configs = await loadAllAgentConfigs();
      const active = configs.filter((c) => c.enabled).length;
      const todayCost = configs.reduce((sum, c) => sum + (c.totalCostToday ?? 0), 0);

      const text = [
        '🤖 *Agent 管理*',
        '',
        `Active: ${active} / Total: ${configs.length}`,
        `今日總花費: $${todayCost.toFixed(2)}`,
      ].join('\n');

      const kb = new InlineKeyboard()
        .text('📋 Agent 列表', 'agm:list')
        .text('⏰ 排程一覽', 'agm:ps')
        .row()
        .text('🔄 Pipeline', 'agm:pipeline')
        .text('📦 巡檢', 'agm:ghpatrol')
        .row()
        .text('◀️ 返回選單', 'menu:home');

      try {
        await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
      } catch {
        await ctx.reply(text.replace(/[*_`[\]]/g, ''), { reply_markup: kb });
      }
    },
  });

  // Inline keyboard callbacks for pipeline/ghpatrol buttons
  commandRegistry.registerCallback('agm:pipeline', async (ctx) => {
    await ctx.answerCallbackQuery();
    await handlePipeline(ctx as BotContext);
  });
  commandRegistry.registerCallback('agm:ghpatrol', async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleGhPatrol(ctx as BotContext);
  });

  // ── Navigation callbacks ──

  commandRegistry.registerCallback('agm:home', async (ctx) => {
    await showHome(ctx);
  });

  commandRegistry.registerCallback('agm:list', async (ctx) => {
    await showAgentList(ctx);
  });

  commandRegistry.registerCallback('agm:ps', async (ctx) => {
    await showProactiveList(ctx);
  });

  // ── Agent detail (must register before agm:d prefix clash — but longest-match handles it) ──

  commandRegistry.registerCallback('agm:d:', async (ctx, data) => {
    await showAgentDetail(ctx, data);
  });

  // ── Schedule editing ──

  commandRegistry.registerCallback('agm:sv:', async (ctx, data) => {
    // data = "NAME:VAL"
    const sep = data.lastIndexOf(':');
    if (sep === -1) return;
    const name = data.slice(0, sep);
    const val = data.slice(sep + 1);
    await setAgentSchedule(ctx, name, val);
  });

  commandRegistry.registerCallback('agm:s:', async (ctx, data) => {
    await showScheduleEdit(ctx, data);
  });

  // ── Budget editing ──

  commandRegistry.registerCallback('agm:bv:', async (ctx, data) => {
    const sep = data.lastIndexOf(':');
    if (sep === -1) return;
    const name = data.slice(0, sep);
    const val = data.slice(sep + 1);
    await setAgentBudget(ctx, name, val);
  });

  commandRegistry.registerCallback('agm:b:', async (ctx, data) => {
    await showBudgetEdit(ctx, data);
  });

  // ── Task budget editing ──

  commandRegistry.registerCallback('agm:tv:', async (ctx, data) => {
    const sep = data.lastIndexOf(':');
    if (sep === -1) return;
    const name = data.slice(0, sep);
    const val = data.slice(sep + 1);
    await setAgentTaskBudget(ctx, name, val);
  });

  commandRegistry.registerCallback('agm:t:', async (ctx, data) => {
    await showTaskBudgetEdit(ctx, data);
  });

  // ── Toggle enabled ──

  commandRegistry.registerCallback('agm:tog:', async (ctx, data) => {
    await toggleAgent(ctx, data);
  });

  // ── Repo list editing ──

  commandRegistry.registerCallback('agm:rp:', async (ctx, data) => {
    await showRepoList(ctx, data);
  });

  commandRegistry.registerCallback('agm:rpa:', async (ctx, data) => {
    await showAddRepo(ctx, data);
  });

  commandRegistry.registerCallback('agm:rpd:', async (ctx, data) => {
    // data = "AGENT:REPO"
    const sep = data.lastIndexOf(':');
    if (sep === -1) return;
    const agentName = data.slice(0, sep);
    const repoName = data.slice(sep + 1);
    await removeRepo(ctx, agentName, repoName);
  });

  commandRegistry.registerCallback('agm:rpav:', async (ctx, data) => {
    // data = "AGENT:REPO"
    const sep = data.lastIndexOf(':');
    if (sep === -1) return;
    const agentName = data.slice(0, sep);
    const repoName = data.slice(sep + 1);
    await addRepo(ctx, agentName, repoName);
  });

  // ── Proactive schedule editing ──

  commandRegistry.registerCallback('agm:ptv:', async (ctx, data) => {
    // data = "KEY:HH:MM"
    const sep = data.indexOf(':');
    if (sep === -1) return;
    const key = data.slice(0, sep);
    const time = data.slice(sep + 1);
    await setProactiveTime(ctx, key, time);
  });

  commandRegistry.registerCallback('agm:pt:', async (ctx, data) => {
    await showProactiveTimeEdit(ctx, data);
  });

  logger.info('commands', 'Registered agent-manager command with interactive navigation');
}
