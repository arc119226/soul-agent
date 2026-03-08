import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Plugin } from '../src/plugins/plugin-api.js';
import { gitStatus, gitLog, gitDiff, gitCommit, gitPull } from '../src/remote/git-ops.js';
import { config } from '../src/config.js';

const execFileAsync = promisify(execFile);

function getCwd(): string {
  return config.CLAUDE_CODE_CWD || process.cwd();
}

/** Run a raw git command (for add/push not in git-ops) */
async function runGit(args: string[]): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: getCwd(),
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, output: (stdout || stderr || '(no output)').trim() };
  } catch (err) {
    const error = err as Error & { stderr?: string };
    return { ok: false, output: error.stderr?.trim() || error.message };
  }
}

/** Get list of changed files (staged + unstaged + untracked) */
async function getChangedFiles(): Promise<{
  staged: string[];
  unstaged: string[];
  untracked: string[];
}> {
  const result = await runGit(['status', '--porcelain']);
  if (!result.ok) return { staged: [], unstaged: [], untracked: [] };

  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];

  for (const line of result.output.split('\n').filter(Boolean)) {
    const index = line[0]!;
    const worktree = line[1]!;
    const file = line.slice(3);

    if (index === '?') {
      untracked.push(file);
    } else {
      if (index !== ' ' && index !== '?') staged.push(file);
      if (worktree !== ' ' && worktree !== '?') unstaged.push(file);
    }
  }

  return { staged, unstaged, untracked };
}

/** Auto-generate commit message from diff stat */
async function generateCommitMessage(): Promise<string> {
  const statResult = await runGit(['diff', '--cached', '--stat']);
  if (!statResult.ok) return 'chore: update files';

  const lines = statResult.output.split('\n').filter(Boolean);
  const summary = lines[lines.length - 1] ?? '';

  // Detect what kind of changes
  const nameResult = await runGit(['diff', '--cached', '--name-only']);
  const files = nameResult.ok ? nameResult.output.split('\n').filter(Boolean) : [];

  const hasSoul = files.some((f) => f.startsWith('soul/'));
  const hasSrc = files.some((f) => f.startsWith('src/'));
  const hasPlugins = files.some((f) => f.startsWith('plugins/'));
  const hasBlog = files.some((f) => f.startsWith('blog/'));

  let type = 'chore';
  let scope = '';

  if (hasBlog) {
    type = 'feat';
    scope = 'blog';
  } else if (hasSrc || hasPlugins) {
    type = 'feat';
    scope = hasPlugins ? 'plugins' : 'core';
  } else if (hasSoul) {
    type = 'chore';
    scope = 'soul';
  }

  const scopePart = scope ? `(${scope})` : '';
  return `${type}${scopePart}: update ${files.length} file${files.length > 1 ? 's' : ''}\n\n${summary}\n\nCo-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`;
}

const HELP_TEXT = `\u2699\uFE0F *Git Workflow*

\u5B50\u547D\u4EE4\uFF1A
\u2022 \`/git\` \u2014 \u72C0\u614B\u7E3D\u89BD
\u2022 \`/git push\` \u2014 \u4E00\u9375 commit + push\uFF08\u81EA\u52D5\u751F\u6210 message\uFF09
\u2022 \`/git push <msg>\` \u2014 \u7528\u6307\u5B9A message commit + push
\u2022 \`/git status\` \u2014 \u8A73\u7D30\u72C0\u614B
\u2022 \`/git diff\` \u2014 \u67E5\u770B\u8B8A\u66F4
\u2022 \`/git log\` \u2014 \u6700\u8FD1 commit \u7D00\u9304
\u2022 \`/git pull\` \u2014 \u62C9\u53D6\u6700\u65B0`;

const plugin: Plugin = {
  meta: {
    name: 'git',
    description: 'Git \u5DE5\u4F5C\u6D41\u7A0B\u81EA\u52D5\u5316',
    icon: '\uD83D\uDD00',
    aliases: ['git', 'commit', 'push', '\u63A8\u4E0A\u53BB', '\u63D0\u4EA4', 'commit+push'],
    version: '1.0.0',
  },

  handler: async (ctx, args) => {
    const parts = args.trim().split(/\s+/);
    const subcommand = parts[0]?.toLowerCase() || '';
    const subArgs = parts.slice(1).join(' ');

    switch (subcommand) {
      case 'push':
      case 'p':
        await handlePush(ctx, subArgs);
        break;
      case 'status':
      case 's':
        await handleStatus(ctx);
        break;
      case 'diff':
      case 'd':
        await handleDiff(ctx);
        break;
      case 'log':
      case 'l':
        await handleLog(ctx, subArgs);
        break;
      case 'pull':
        await handlePull(ctx);
        break;
      case 'help':
      case 'h':
        await ctx.sendMarkdown(HELP_TEXT);
        break;
      default:
        // No subcommand = dashboard overview
        await handleDashboard(ctx);
        break;
    }
  },
};

async function handleDashboard(ctx: { sendMarkdown: (text: string) => Promise<void> }) {
  const { staged, unstaged, untracked } = await getChangedFiles();
  const total = staged.length + unstaged.length + untracked.length;

  const logResult = await runGit(['log', '--oneline', '-3', '--format=%h %s']);
  const recentCommits = logResult.ok ? logResult.output : '(unavailable)';

  const branchResult = await runGit(['branch', '--show-current']);
  const branch = branchResult.ok ? branchResult.output : 'unknown';

  const aheadResult = await runGit(['rev-list', '--count', '@{upstream}..HEAD']);
  const ahead = aheadResult.ok ? parseInt(aheadResult.output, 10) : 0;

  const lines = [
    `\uD83D\uDD00 *Git Dashboard*`,
    ``,
    `\uD83C\uDF3F Branch: \`${branch}\``,
    ahead > 0 ? `\u2B06\uFE0F Ahead: ${ahead} commit${ahead > 1 ? 's' : ''} (unpushed)` : `\u2705 In sync with remote`,
    ``,
  ];

  if (total === 0) {
    lines.push('\u2728 Working tree clean');
  } else {
    lines.push(`\uD83D\uDCDD Changes: ${total} file${total > 1 ? 's' : ''}`);
    if (staged.length > 0) lines.push(`  \u2705 Staged: ${staged.length}`);
    if (unstaged.length > 0) lines.push(`  \u270F\uFE0F Modified: ${unstaged.length}`);
    if (untracked.length > 0) lines.push(`  \u2753 Untracked: ${untracked.length}`);
    lines.push('');
    lines.push('\uD83D\uDCA1 \u7528 `/git push` \u4E00\u9375\u63D0\u4EA4\u4E26\u63A8\u9001');
  }

  lines.push('', `\uD83D\uDCCB *\u6700\u8FD1 Commits*`, '```', recentCommits, '```');

  await ctx.sendMarkdown(lines.join('\n'));
}

async function handlePush(
  ctx: { sendMarkdown: (text: string) => Promise<void> },
  customMessage: string,
) {
  await ctx.sendMarkdown('\u23F3 \u6B63\u5728\u57F7\u884C commit + push...');

  // 1. Check for changes
  const { staged, unstaged, untracked } = await getChangedFiles();
  const total = staged.length + unstaged.length + untracked.length;

  if (total === 0) {
    await ctx.sendMarkdown('\u2705 \u6C92\u6709\u4EFB\u4F55\u8B8A\u66F4\u9700\u8981\u63D0\u4EA4\u3002');
    return;
  }

  // 2. Stage all changes (unstaged + untracked), excluding .env and data/
  const filesToAdd = [...unstaged, ...untracked].filter(
    (f) => !f.startsWith('.env') && !f.startsWith('data/') && !f.startsWith('node_modules/'),
  );

  if (filesToAdd.length > 0) {
    const addResult = await runGit(['add', ...filesToAdd]);
    if (!addResult.ok) {
      await ctx.sendMarkdown(`\u274C git add \u5931\u6557\uFF1A\n\`\`\`\n${addResult.output}\n\`\`\``);
      return;
    }
  }

  // If we already have staged files, include them too
  // (they're already staged, no action needed)

  // 3. Generate or use custom commit message
  const message = customMessage.trim() || (await generateCommitMessage());

  // 4. Commit
  const commitResult = await gitCommit(message);
  if (!commitResult.ok) {
    await ctx.sendMarkdown(`\u274C commit \u5931\u6557\uFF1A\n${commitResult.error}`);
    return;
  }

  // 5. Push
  const pushResult = await runGit(['push', 'origin', 'HEAD']);
  if (!pushResult.ok) {
    await ctx.sendMarkdown(
      `\u2705 Committed \u6210\u529F\uFF0C\u4F46 push \u5931\u6557\uFF1A\n\`\`\`\n${pushResult.output}\n\`\`\`\n\n\u53EF\u4EE5\u624B\u52D5\u57F7\u884C \`git push\``,
    );
    return;
  }

  // 6. Summary
  const shortHash = await runGit(['rev-parse', '--short', 'HEAD']);
  const hash = shortHash.ok ? shortHash.output : '???';
  const fileCount = staged.length + filesToAdd.length;
  const firstLine = message.split('\n')[0] ?? '';

  await ctx.sendMarkdown(
    [
      `\u2705 *Commit + Push \u5B8C\u6210*`,
      ``,
      `\uD83D\uDD16 \`${hash}\` ${firstLine}`,
      `\uD83D\uDCE6 ${fileCount} file${fileCount > 1 ? 's' : ''}`,
    ].join('\n'),
  );
}

async function handleStatus(ctx: { sendMarkdown: (text: string) => Promise<void> }) {
  const result = await gitStatus();
  if (result.ok) {
    await ctx.sendMarkdown(result.value);
  } else {
    await ctx.sendMarkdown(`\u274C ${result.error}`);
  }
}

async function handleDiff(ctx: { sendMarkdown: (text: string) => Promise<void> }) {
  const result = await gitDiff();
  if (result.ok) {
    await ctx.sendMarkdown(result.value);
  } else {
    await ctx.sendMarkdown(`\u274C ${result.error}`);
  }
}

async function handleLog(
  ctx: { sendMarkdown: (text: string) => Promise<void> },
  countStr: string,
) {
  const count = parseInt(countStr, 10) || 10;
  const result = await gitLog(count);
  if (result.ok) {
    await ctx.sendMarkdown(result.value);
  } else {
    await ctx.sendMarkdown(`\u274C ${result.error}`);
  }
}

async function handlePull(ctx: { sendMarkdown: (text: string) => Promise<void> }) {
  await ctx.sendMarkdown('\u23F3 \u6B63\u5728\u62C9\u53D6...');
  const result = await gitPull();
  if (result.ok) {
    await ctx.sendMarkdown(`\u2705 Pull \u5B8C\u6210\n\n${result.value}`);
  } else {
    await ctx.sendMarkdown(`\u274C Pull \u5931\u6557\uFF1A\n${result.error}`);
  }
}

export default plugin;
