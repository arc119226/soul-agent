/**
 * Schedules handler — unified schedule overview.
 * Registered as /sys schedules via sys.ts.
 */

import { scheduleEngine, type ScheduleEntry } from '../core/schedule-engine.js';
import type { BotContext } from '../bot.js';

function formatLastRun(entry: ScheduleEntry): string {
  if (!entry.lastRun) return '—';
  const d = new Date(entry.lastRun);
  const today = new Date().toDateString();
  const runDay = d.toDateString();
  const time = d.toISOString().slice(11, 16);
  return runDay === today ? `today ${time}` : d.toISOString().slice(5, 16).replace('T', ' ');
}

function formatSection(title: string, entries: ScheduleEntry[]): string[] {
  if (entries.length === 0) return [];
  const lines = [`*${title}* (${entries.length})`, ''];
  for (const e of entries) {
    const id = e.id.replace(/^(proactive|agent|heartbeat|evolution):/, '');
    const status = e.meta?.lastResult === 'failure' ? ' ❌' : '';
    const selfTag = e.selfManaged ? ' ~' : '';
    lines.push(`  \`${id}\` ${selfTag}${e.cronExpr}  last: ${formatLastRun(e)}${status}`);
  }
  return lines;
}

export async function handleSchedules(ctx: BotContext): Promise<void> {
  const all = scheduleEngine.getAll();
  const bySource = {
    proactive: all.filter((e) => e.source === 'proactive'),
    agent: all.filter((e) => e.source === 'agent'),
    heartbeat: all.filter((e) => e.source === 'heartbeat'),
    evolution: all.filter((e) => e.source === 'evolution'),
  };

  const lines = [
    `*排程概覽* (${all.length} entries)`,
    '',
    ...formatSection('主動任務 (proactive)', bySource.proactive),
    '',
    ...formatSection('背景代理 (agent)', bySource.agent),
    '',
    ...formatSection('心跳任務 (heartbeat)', bySource.heartbeat),
    '',
    ...formatSection('自我進化 (evolution)', bySource.evolution),
  ].filter((_, i, arr) => {
    if (i === 0) return true;
    return !(arr[i] === '' && arr[i - 1] === '');
  });

  const output = lines.join('\n');
  try {
    await ctx.reply(output, { parse_mode: 'Markdown' });
  } catch {
    await ctx.reply(output.replace(/\*/g, '').replace(/`/g, ''));
  }
}
