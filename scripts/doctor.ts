/**
 * scripts/doctor.ts — Environment health check
 *
 * Usage:
 *   node --import tsx/esm scripts/doctor.ts
 *   npm run doctor
 *
 * Exit codes:
 *   0 — all checks passed (WARN/INFO are non-fatal)
 *   1 — at least one FAIL
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Types ───────────────────────────────────────

type CheckStatus = 'ok' | 'warn' | 'fail' | 'info';

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

// ── Check helpers ───────────────────────────────

async function checkNodeVersion(): Promise<CheckResult> {
  const version = process.version; // e.g. "v22.0.0"
  const major = parseInt(version.slice(1).split('.')[0], 10);
  if (major >= 20) {
    return { name: `Node.js ${version} (>=20.0.0)`, status: 'ok', detail: '' };
  }
  return {
    name: `Node.js ${version}`,
    status: 'fail',
    detail: 'requires >= 20.0.0',
  };
}

async function checkCommand(label: string, cmd: string, args: string[]): Promise<CheckResult> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 10_000 });
    const version = stdout.trim().split('\n')[0];
    return { name: `${label} ${version}`, status: 'ok', detail: '' };
  } catch (err: unknown) {
    const isNotFound = (err as NodeJS.ErrnoException).code === 'ENOENT';
    return {
      name: label,
      status: 'fail',
      detail: isNotFound ? 'not found in PATH' : 'command failed',
    };
  }
}

async function checkFileExists(filePath: string, label: string): Promise<CheckResult> {
  if (existsSync(filePath)) {
    return { name: label, status: 'ok', detail: '' };
  }
  return { name: label, status: 'fail', detail: `${filePath} not found` };
}

async function checkAgentConfigs(): Promise<CheckResult> {
  const agentsDir = join(ROOT, 'soul', 'agents');
  if (!existsSync(agentsDir)) {
    return { name: 'soul/agents/', status: 'fail', detail: 'directory not found' };
  }
  try {
    const files = readdirSync(agentsDir).filter(f => f.endsWith('.json'));
    if (files.length === 0) {
      return { name: 'soul/agents/', status: 'warn', detail: 'no agent configs — run: npm run setup' };
    }
    return { name: `soul/agents/ (${files.length} configs)`, status: 'ok', detail: '' };
  } catch {
    return { name: 'soul/agents/', status: 'fail', detail: 'cannot read directory' };
  }
}

async function checkIdentityJson(): Promise<CheckResult> {
  const path = join(ROOT, 'soul', 'identity.json');
  if (!existsSync(path)) {
    return { name: 'soul/identity.json', status: 'fail', detail: 'not found — run: npm run setup' };
  }
  try {
    JSON.parse(readFileSync(path, 'utf-8'));
    return { name: 'soul/identity.json', status: 'ok', detail: '' };
  } catch {
    return { name: 'soul/identity.json', status: 'fail', detail: 'invalid JSON' };
  }
}

async function checkDotEnvAndToken(): Promise<CheckResult> {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) {
    return { name: '.env + BOT_TOKEN', status: 'fail', detail: '.env not found' };
  }
  try {
    const content = readFileSync(envPath, 'utf-8');
    // Look for BOT_TOKEN=<non-empty value>
    const match = content.match(/^BOT_TOKEN\s*=\s*(.+)$/m);
    if (match && match[1].trim().length > 0) {
      return { name: '.env + BOT_TOKEN', status: 'ok', detail: '' };
    }
    return { name: '.env + BOT_TOKEN', status: 'fail', detail: 'BOT_TOKEN not set in .env' };
  } catch {
    return { name: '.env + BOT_TOKEN', status: 'fail', detail: 'cannot read .env' };
  }
}

async function checkNodeModules(dir: string, label: string): Promise<CheckResult> {
  const nmPath = join(ROOT, dir, 'node_modules');
  const pkgPath = join(ROOT, dir, 'package.json');

  if (!existsSync(pkgPath)) {
    return { name: label, status: 'info', detail: `${dir}/package.json not found — skipped` };
  }
  if (existsSync(nmPath)) {
    return { name: label, status: 'ok', detail: '' };
  }
  return { name: label, status: 'warn', detail: `run: npm install (in ${dir}/)` };
}

async function checkEnvVar(
  varName: string,
  level: CheckStatus,
  notSetMsg: string,
): Promise<CheckResult> {
  const value = process.env[varName];
  if (value && value.trim().length > 0) {
    return { name: varName, status: 'ok', detail: 'set' };
  }
  return { name: varName, status: level, detail: notSetMsg };
}

// ── Formatting ──────────────────────────────────

const STATUS_ICON: Record<CheckStatus, string> = {
  ok: '✓ OK',
  warn: '⚠ WARN',
  fail: '✗ FAIL',
  info: 'ℹ INFO',
};

function formatRow(result: CheckResult): string {
  const { name, status, detail } = result;
  const icon = STATUS_ICON[status];
  const suffix = detail ? ` (${detail})` : '';
  const label = `${name}${suffix}`;
  // Pad label to 42 chars for alignment
  const padded = label.padEnd(42, ' ');
  return `  ${padded} ${icon}`;
}

// ── Main ────────────────────────────────────────

const checks: Promise<CheckResult>[] = [
  checkNodeVersion(),
  checkCommand('npm', 'npm', ['--version']),
  checkCommand('Claude CLI', 'claude', ['--version']),
  checkCommand('Git', 'git', ['--version']),
  checkFileExists(join(ROOT, 'soul', 'genesis.md'), 'soul/genesis.md'),
  checkIdentityJson(),
  checkFileExists(join(ROOT, 'soul', 'agents', 'templates'), 'soul/agents/templates/'),
  checkAgentConfigs(),
  checkDotEnvAndToken(),
  checkNodeModules('blog', 'blog/ dependencies'),
  checkNodeModules('report', 'report/ dependencies'),
  checkEnvVar('WORKTREE_BASE', 'warn', `not set, using ~/worktrees`),
  checkEnvVar('ANTHROPIC_API_KEY', 'info', 'not set'),
];

const results = await Promise.all(checks);

const DIVIDER = '─'.repeat(48);
console.log('\nEnvironment Health Check');
console.log(DIVIDER);
for (const r of results) {
  console.log(formatRow(r));
}
console.log(DIVIDER);

const fails = results.filter(r => r.status === 'fail').length;
const warns = results.filter(r => r.status === 'warn').length;
const infos = results.filter(r => r.status === 'info').length;

let statusLine: string;
if (fails > 0) {
  const parts = [`${fails} failure${fails > 1 ? 's' : ''}`];
  if (warns > 0) parts.push(`${warns} warning${warns > 1 ? 's' : ''}`);
  if (infos > 0) parts.push(`${infos} info`);
  statusLine = `Status: Not runnable (${parts.join(', ')})`;
} else if (warns > 0 || infos > 0) {
  const parts: string[] = [];
  if (warns > 0) parts.push(`${warns} warning${warns > 1 ? 's' : ''}`);
  if (infos > 0) parts.push(`${infos} info`);
  statusLine = `Status: Runnable (${parts.join(', ')})`;
} else {
  statusLine = 'Status: All checks passed';
}

console.log(statusLine);
console.log();

process.exit(fails > 0 ? 1 : 0);
