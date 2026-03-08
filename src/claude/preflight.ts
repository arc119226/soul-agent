import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../core/logger.js';

const execFileAsync = promisify(execFile);

export interface AuthPreflightReport {
  cliAvailable: boolean;
  cliVersion: string | null;
  apiKeyPresent: boolean;
  /** One-line summary for admin notification */
  summary: string;
  warnings: string[];
}

/**
 * Lightweight startup check for Claude authentication.
 *
 * Checks:
 * 1. `claude --version` — confirms CLI is in PATH (no API call, no token usage)
 * 2. ANTHROPIC_API_KEY presence — warns if the SDK fallback path will be degraded
 *
 * Intentionally does NOT do a connectivity test (would consume tokens on every restart).
 * The first real Claude call acts as the connectivity test.
 */
export async function checkClaudeAuth(): Promise<AuthPreflightReport> {
  const warnings: string[] = [];
  let cliAvailable = false;
  let cliVersion: string | null = null;
  const apiKeyPresent = !!process.env.ANTHROPIC_API_KEY;

  // Check 1: Is `claude` CLI available in PATH?
  try {
    const { stdout } = await execFileAsync('claude', ['--version'], {
      timeout: 10_000,
      windowsHide: true,
    });
    cliAvailable = true;
    cliVersion = stdout.trim().split('\n')[0] ?? null;
  } catch (err: unknown) {
    cliAvailable = false;
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') {
      warnings.push('Claude CLI not found in PATH — all Claude calls will fail until installed');
    } else {
      warnings.push(`Claude CLI check failed: ${nodeErr.message}`);
    }
  }

  // Check 2: API key for the SDK fallback path (route-decision classifier)
  if (!apiKeyPresent) {
    warnings.push(
      'ANTHROPIC_API_KEY not set — route-decision LLM classifier will use pattern-only fallback',
    );
  }

  const cliStatus = cliAvailable ? `OK (${cliVersion})` : 'MISSING';
  const keyStatus = apiKeyPresent ? 'set' : 'not set';
  const summary = `CLI: ${cliStatus} | API Key: ${keyStatus}`;

  for (const w of warnings) {
    logger.warn('preflight', w);
  }

  if (warnings.length === 0) {
    logger.info('preflight', `Auth preflight passed: ${summary}`);
  } else {
    logger.info('preflight', `Auth preflight completed with warnings: ${summary}`);
  }

  return { cliAvailable, cliVersion, apiKeyPresent, summary, warnings };
}
