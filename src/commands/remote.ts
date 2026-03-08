/**
 * Remote operation handlers (files, run, git, sysinfo).
 * Registered as /sys subcommands via sys.ts.
 */

import { commandRegistry } from '../telegram/command-registry.js';
import { listDirectory, formatListing, handleFileBrowserCallback } from '../remote/file-browser.js';
import { executeCode, formatExecutionResult } from '../remote/code-runner.js';
import { gitStatus, gitLog, gitDiff, gitBranch, gitCommit } from '../remote/git-ops.js';
import {
  getSystemInfo,
  getProcessInfo,
  getDiskUsage,
  formatSystemInfo,
  formatProcessInfo,
  formatDiskUsage,
} from '../remote/system-monitor.js';
import { formatUserError } from '../telegram/helpers.js';
import type { BotContext } from '../bot.js';

/** /sys files [path] — browse files */
export async function handleFiles(ctx: BotContext): Promise<void> {
  const text = ctx.message?.text ?? '';
  const path = text.replace(/^\/(?:sys\s+)?files\s*/i, '').trim() || undefined;

  const result = await listDirectory(path);
  if (!result.ok) {
    await ctx.reply(formatUserError('cli-error', result.error));
    return;
  }

  const formatted = formatListing(result.value);
  try {
    await ctx.reply(formatted, {
      parse_mode: 'Markdown',
      reply_markup: result.value.keyboard,
    });
  } catch {
    await ctx.reply(formatted.replace(/[*`]/g, ''), {
      reply_markup: result.value.keyboard,
    });
  }
}

/** /sys run <language> <code> — execute code */
export async function handleRun(ctx: BotContext): Promise<void> {
  const text = ctx.message?.text ?? '';
  const content = text.replace(/^\/(?:sys\s+)?run\s*/i, '').trim();

  if (!content) {
    await ctx.reply(
      'Usage: `/sys run <language> <code>`\n\n' +
      'Supported languages: node, ts, python, bash\n\n' +
      'Example:\n`/sys run node console.log("hello")`\n' +
      '`/sys run bash ls -la`',
      { parse_mode: 'Markdown' },
    );
    return;
  }

  let language: string;
  let code: string;

  const codeBlockMatch = content.match(/^(\w+)\s*```[\w]*\n?([\s\S]*?)```$/);
  if (codeBlockMatch) {
    language = codeBlockMatch[1]!;
    code = codeBlockMatch[2]!;
  } else {
    const spaceIdx = content.indexOf(' ');
    if (spaceIdx === -1) {
      await ctx.reply('Please provide both language and code.\nExample: `/sys run node console.log("hi")`', {
        parse_mode: 'Markdown',
      });
      return;
    }
    language = content.slice(0, spaceIdx);
    code = content.slice(spaceIdx + 1);
  }

  await ctx.reply(`Running ${language} code...`);

  const result = await executeCode(language, code);
  if (!result.ok) {
    await ctx.reply(formatUserError('cli-error', result.error));
    return;
  }

  const formatted = formatExecutionResult(result.value);
  try {
    await ctx.reply(formatted, { parse_mode: 'Markdown' });
  } catch {
    await ctx.reply(formatted.replace(/[*`_]/g, ''));
  }
}

/** /sys git [subcommand] — git operations */
export async function handleGit(ctx: BotContext): Promise<void> {
  const text = ctx.message?.text ?? '';
  const args = text.replace(/^\/(?:sys\s+)?git\s*/i, '').trim();
  const parts = args.split(/\s+/);
  const subcommand = parts[0]?.toLowerCase() || 'status';

  let result;
  switch (subcommand) {
    case 'status':
    case 's':
      result = await gitStatus();
      break;
    case 'log':
    case 'l': {
      const count = parseInt(parts[1] ?? '10', 10);
      result = await gitLog(count);
      break;
    }
    case 'diff':
    case 'd':
      result = await gitDiff();
      break;
    case 'branch':
    case 'b':
      result = await gitBranch();
      break;
    case 'commit':
    case 'c': {
      const message = parts.slice(1).join(' ');
      if (!message) {
        await ctx.reply('Usage: `/sys git commit <message>`', { parse_mode: 'Markdown' });
        return;
      }
      result = await gitCommit(message);
      break;
    }
    default:
      await ctx.reply(
        '*Git Commands:*\n\n' +
        '`/sys git status` — working tree status\n' +
        '`/sys git log [n]` — recent commits\n' +
        '`/sys git diff` — current changes\n' +
        '`/sys git branch` — branch info\n' +
        '`/sys git commit <msg>` — commit staged changes',
        { parse_mode: 'Markdown' },
      );
      return;
  }

  if (!result.ok) {
    await ctx.reply(formatUserError('cli-error', result.error));
    return;
  }

  try {
    await ctx.reply(result.value, { parse_mode: 'Markdown' });
  } catch {
    await ctx.reply(result.value.replace(/[*`]/g, ''));
  }
}

/** /sys info — system information */
export async function handleSysinfo(ctx: BotContext): Promise<void> {
  const sysResult = getSystemInfo();
  const procResult = getProcessInfo();
  const diskResult = await getDiskUsage();

  const sections: string[] = [];

  if (sysResult.ok) {
    sections.push(formatSystemInfo(sysResult.value));
  }

  if (procResult.ok) {
    sections.push(formatProcessInfo(procResult.value));
  }

  if (diskResult.ok) {
    sections.push(formatDiskUsage(diskResult.value));
  }

  const message = sections.join('\n\n' + '─'.repeat(25) + '\n\n');

  try {
    await ctx.reply(message, { parse_mode: 'Markdown' });
  } catch {
    await ctx.reply(message.replace(/[*`]/g, ''));
  }
}

/** Register file browser callback */
export function registerRemoteCallbacks(): void {
  commandRegistry.registerCallback('fb:', handleFileBrowserCallback);
}
