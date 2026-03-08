import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { logger } from '../core/logger.js';
import { ok, fail, type Result } from '../result.js';

const execFileAsync = promisify(execFile);
const MODULE = 'git-ops';

/** Max output for Telegram */
const MAX_OUTPUT = 4000;

/** Get the working directory for git operations */
function getCwd(): string {
  return config.CLAUDE_CODE_CWD || process.cwd();
}

/** Run a git command and return output */
async function runGit(args: string[], cwd?: string): Promise<Result<string>> {
  const workDir = cwd || getCwd();
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: workDir,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });

    let output = stdout.trim();
    if (!output && stderr.trim()) {
      output = stderr.trim();
    }
    if (!output) {
      output = '(no output)';
    }

    return ok('Git command executed', output);
  } catch (err) {
    const error = err as Error & { stderr?: string };
    logger.error(MODULE, `Git command failed: git ${args.join(' ')}`, err);
    return fail(
      `Git error: ${error.stderr?.trim() || error.message}`,
    );
  }
}

/** Get git status */
export async function gitStatus(): Promise<Result<string>> {
  const result = await runGit(['status', '--short', '--branch']);
  if (!result.ok) return result;

  const lines = result.value.split('\n');
  const branch = lines[0] ?? '';
  const changes = lines.slice(1).filter(Boolean);

  const formatted = [
    '*Git Status*',
    '',
    `Branch: \`${branch.replace('## ', '')}\``,
    '',
    changes.length > 0 ? changes.map((l) => `\`${l}\``).join('\n') : 'Working tree clean',
  ].join('\n');

  return ok('Git status', formatted);
}

/** Get recent git log */
export async function gitLog(count: number = 10): Promise<Result<string>> {
  const result = await runGit([
    'log',
    `--oneline`,
    `--graph`,
    `-n`,
    String(Math.min(count, 50)),
    '--format=%h %s (%ar)',
  ]);
  if (!result.ok) return result;

  let output = result.value;
  if (output.length > MAX_OUTPUT) {
    output = output.slice(0, MAX_OUTPUT) + '\n... (truncated)';
  }

  const formatted = `*Recent Commits*\n\n\`\`\`\n${output}\n\`\`\``;
  return ok('Git log', formatted);
}

/** Get current diff */
export async function gitDiff(): Promise<Result<string>> {
  // Try staged first, fall back to unstaged
  let result = await runGit(['diff', '--cached', '--stat']);
  if (result.ok && result.value === '(no output)') {
    result = await runGit(['diff', '--stat']);
  }

  if (!result.ok) return result;

  let output = result.value;
  if (output.length > MAX_OUTPUT) {
    output = output.slice(0, MAX_OUTPUT) + '\n... (truncated)';
  }

  const formatted = `*Git Diff*\n\n\`\`\`\n${output}\n\`\`\``;
  return ok('Git diff', formatted);
}

/** Commit staged changes */
export async function gitCommit(message: string): Promise<Result<string>> {
  if (!message.trim()) {
    return fail('Commit message is required');
  }

  const result = await runGit(['commit', '-m', message]);
  if (!result.ok) return result;

  const formatted = `*Git Commit*\n\n${result.value}`;
  return ok('Committed', formatted);
}

/** Get current branch info */
export async function gitBranch(): Promise<Result<string>> {
  const result = await runGit(['branch', '-v', '--no-color']);
  if (!result.ok) return result;

  let output = result.value;
  if (output.length > MAX_OUTPUT) {
    output = output.slice(0, MAX_OUTPUT) + '\n... (truncated)';
  }

  const formatted = `*Git Branches*\n\n\`\`\`\n${output}\n\`\`\``;
  return ok('Git branches', formatted);
}

/** Pull latest changes */
export async function gitPull(): Promise<Result<string>> {
  const result = await runGit(['pull', '--ff-only']);
  if (!result.ok) return result;

  return ok('Git pull', `*Git Pull*\n\n${result.value}`);
}
