/**
 * /pipeline command — trigger and monitor multi-agent team pipelines.
 *
 * Usage:
 *   /pipeline <team-name> <prompt>   — Start a pipeline
 *   /pipeline status                 — Show active pipelines
 *   /pipeline list                   — List available team templates
 *   /pipeline abort <runId>          — Abort a running pipeline
 */

import { commandRegistry } from '../telegram/command-registry.js';
import {
  startPipeline,
  getActivePipelines,
  abortPipeline,
  resumePipeline,
} from '../agents/pipeline-engine.js';
import { listTeamNames, loadTeamTemplate } from '../agents/config/team-config.js';
import type { BotContext } from '../bot.js';

export async function handlePipeline(ctx: BotContext): Promise<void> {
  const text = ctx.message?.text ?? '';
  const args = text.replace(/^\/(?:agents\s+)?pipeline\s*/i, '').trim();

  // /pipeline (no args) — show help or status
  if (!args) {
    const active = getActivePipelines();
    if (active.length > 0) {
      const lines = ['🔄 執行中的 Pipeline：', ''];
      for (const run of active) {
        const completed = Object.values(run.stages).filter((s) => s.status === 'completed').length;
        const total = Object.keys(run.stages).length;
        lines.push(`📋 ${run.teamName} — ${completed}/${total} stages`);
        lines.push(`   ID: ${run.id.slice(0, 8)}...`);
        lines.push(`   Prompt: ${run.prompt.slice(0, 50)}...`);
        lines.push('');
      }
      await ctx.reply(lines.join('\n'));
      return;
    }

    const names = await listTeamNames();
    const help = [
      '📋 Pipeline 系統 — 多 Agent 團隊協作',
      '',
      '用法：',
      '  /agents pipeline <team> <prompt>  啟動 pipeline',
      '  /agents pipeline status           查看執行中',
      '  /agents pipeline list             列出可用模板',
      '  /agents pipeline abort <id>       中止 pipeline',
      '  /agents pipeline resume <id> <stage>  從指定 stage 恢復已中止的 pipeline',
      '',
      '範例：',
      '  /agents pipeline content-pipeline 深入研究 Cloudflare Workers 冷啟動優化',
      '  /agents pipeline security-patrol 檢查最近一週的程式碼安全性',
      '  /agents pipeline market-intelligence 分析本週 AI 和加密貨幣趨勢',
      '',
      `可用模板：${names.join(', ') || '(無)'}`,
    ];
    await ctx.reply(help.join('\n'));
    return;
  }

  // /pipeline status
  if (args === 'status') {
    const active = getActivePipelines();
    if (active.length === 0) {
      await ctx.reply('目前沒有執行中的 pipeline。');
      return;
    }

    const lines = ['🔄 執行中的 Pipeline：', ''];
    for (const run of active) {
      const completed = Object.values(run.stages).filter((s) => s.status === 'completed').length;
      const total = Object.keys(run.stages).length;
      lines.push(`📋 ${run.teamName} — ${completed}/${total} stages`);
      lines.push(`   ID: ${run.id.slice(0, 8)}...`);
      lines.push(`   Prompt: ${run.prompt.slice(0, 50)}...`);
      lines.push('');
    }
    await ctx.reply(lines.join('\n'));
    return;
  }

  // /pipeline list
  if (args === 'list') {
    const names = await listTeamNames();
    if (names.length === 0) {
      await ctx.reply('沒有可用的團隊模板。');
      return;
    }

    const lines = ['📦 可用的團隊模板：', ''];
    for (const name of names) {
      const template = await loadTeamTemplate(name);
      if (template) {
        const stageNames = template.workflow.stages.map((s) => s.agentName).join(' → ');
        lines.push(`• ${name} — ${template.description.slice(0, 50)}`);
        lines.push(`  流程：${stageNames}`);
        lines.push(`  預算：$${template.budget.maxTotalCostUsd}`);
        lines.push('');
      }
    }
    await ctx.reply(lines.join('\n'));
    return;
  }

  // /pipeline abort <runId>
  if (args.startsWith('abort ')) {
    const runId = args.replace('abort ', '').trim();
    const active = getActivePipelines();
    const match = active.find((p) => p.id.startsWith(runId));
    if (!match) {
      await ctx.reply(`找不到 ID 開頭為 "${runId}" 的 pipeline。`);
      return;
    }
    await abortPipeline(match.id, 'User requested abort');
    await ctx.reply(`Pipeline ${match.id.slice(0, 8)}... 已中止。`);
    return;
  }

  // /pipeline resume <runId> <stageId>
  if (args.startsWith('resume ')) {
    const resumeArgs = args.replace('resume ', '').trim().split(/\s+/);
    const runIdPrefix = resumeArgs[0];
    const stageId = resumeArgs[1];
    if (!runIdPrefix || !stageId) {
      await ctx.reply('用法：/pipeline resume <runId> <stageId>\n\nrunId 支援前綴匹配。');
      return;
    }

    // Find matching pipeline from disk (prefix match)
    const { readdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const pipelinesDir = join(process.cwd(), 'soul', 'agent-tasks', 'pipelines');
    let matchedRunId: string | null = null;
    try {
      const files = await readdir(pipelinesDir);
      const match = files.find(f => f.startsWith(runIdPrefix) && f.endsWith('.json'));
      if (match) matchedRunId = match.replace('.json', '');
    } catch { /* dir not found */ }

    if (!matchedRunId) {
      await ctx.reply(`找不到 ID 開頭為 "${runIdPrefix}" 的 pipeline。`);
      return;
    }

    const run = await resumePipeline(matchedRunId, stageId);
    if (!run) {
      await ctx.reply('Resume 失敗。可能原因：pipeline 仍在執行中、stage ID 不存在、或依賴的 stage 未完成。');
      return;
    }

    await ctx.reply(
      `Pipeline 已恢復！\n` +
      `新 ID: ${run.id.slice(0, 8)}...\n` +
      `原始 ID: ${matchedRunId.slice(0, 8)}...\n` +
      `從 stage「${stageId}」開始執行`,
    );
    return;
  }

  // /pipeline <team-name> <prompt>
  const firstSpace = args.indexOf(' ');
  if (firstSpace === -1) {
    // Only team name, no prompt
    await ctx.reply('請提供 prompt。用法：/pipeline <team-name> <prompt>');
    return;
  }

  const teamName = args.slice(0, firstSpace);
  const prompt = args.slice(firstSpace + 1).trim();

  const template = await loadTeamTemplate(teamName);
  if (!template) {
    const available = await listTeamNames();
    await ctx.reply(
      `找不到團隊模板「${teamName}」。\n\n可用模板：${available.join(', ') || '(無)'}`,
    );
    return;
  }

  await ctx.reply(
    `🚀 啟動 pipeline「${teamName}」...\n` +
    `流程：${template.workflow.stages.map((s) => s.agentName).join(' → ')}\n` +
    `預算上限：$${template.budget.maxTotalCostUsd}`,
  );

  const run = await startPipeline(teamName, prompt);
  if (!run) {
    await ctx.reply('Pipeline 啟動失敗。請查看日誌。');
    return;
  }

  await ctx.reply(
    `Pipeline 已啟動！\n` +
    `ID: ${run.id.slice(0, 8)}...\n` +
    `第一階段「${template.workflow.stages[0]?.id}」已派發，等待 agent 執行...`,
  );
}

export function registerPipelineCommand(): void {
  commandRegistry.registerCommand({
    name: 'pipeline',
    description: '啟動多 Agent 團隊 Pipeline',
    aliases: ['pipe', '管線'],
    handler: handlePipeline,
  });
}
