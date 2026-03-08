import { spawn } from 'node:child_process';
import { writeFile, unlink, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { logger } from '../core/logger.js';
import { ok, fail, type Result } from '../result.js';

const MODULE = 'code-runner';

/** Default execution timeout in ms */
const DEFAULT_TIMEOUT = 30_000;
/** Max output length for Telegram */
const MAX_OUTPUT = 4000;

export interface ExecutionResult {
  output: string;
  exitCode: number | null;
  duration: number;
  language: string;
  truncated: boolean;
}

type SupportedLanguage = 'node' | 'ts' | 'typescript' | 'python' | 'py' | 'bash' | 'sh';

/** Resolve language alias to canonical name */
function resolveLanguage(lang: string): SupportedLanguage | null {
  const lower = lang.toLowerCase().trim();
  const aliases: Record<string, SupportedLanguage> = {
    node: 'node',
    js: 'node',
    javascript: 'node',
    ts: 'ts',
    typescript: 'ts',
    python: 'python',
    py: 'python',
    python3: 'python',
    bash: 'bash',
    sh: 'bash',
    shell: 'bash',
  };
  return aliases[lower] ?? null;
}

/** Execute code in the specified language */
export async function executeCode(
  language: string,
  code: string,
  timeout: number = DEFAULT_TIMEOUT,
): Promise<Result<ExecutionResult>> {
  const lang = resolveLanguage(language);
  if (!lang) {
    return fail(
      `Unsupported language: ${language}`,
      'Supported: node/js, ts/typescript, python/py, bash/sh',
    );
  }

  const startTime = Date.now();
  let tmpDir: string | undefined;

  try {
    tmpDir = await mkdtemp(join(tmpdir(), 'coderun-'));
    const { cmd, args, cleanupFile } = await prepareExecution(lang, code, tmpDir);

    const result = await runProcess(cmd, args, timeout);
    const duration = Date.now() - startTime;

    // Cleanup temp file
    if (cleanupFile) {
      try {
        await unlink(cleanupFile);
      } catch {
        // ignore cleanup errors
      }
    }

    let output = combineOutput(result.stdout, result.stderr);
    let truncated = false;

    if (output.length > MAX_OUTPUT) {
      output = output.slice(0, MAX_OUTPUT);
      truncated = true;
    }

    if (!output.trim()) {
      output = '(no output)';
    }

    const execResult: ExecutionResult = {
      output,
      exitCode: result.exitCode,
      duration,
      language: lang,
      truncated,
    };

    logger.info(MODULE, `Code executed: ${lang}, exit=${result.exitCode}, ${duration}ms`);
    return ok('Code executed', execResult);
  } catch (err) {
    const duration = Date.now() - startTime;
    logger.error(MODULE, `Execution error: ${lang}`, err);

    if ((err as Error).message?.includes('TIMEOUT')) {
      return ok('Execution timed out', {
        output: `Execution timed out after ${timeout / 1000}s`,
        exitCode: null,
        duration,
        language: lang,
        truncated: false,
      });
    }

    return fail(`Execution failed: ${(err as Error).message}`);
  }
}

/** Prepare command and arguments for execution */
async function prepareExecution(
  lang: SupportedLanguage,
  code: string,
  tmpDir: string,
): Promise<{ cmd: string; args: string[]; cleanupFile?: string }> {
  switch (lang) {
    case 'node': {
      const file = join(tmpDir, 'script.mjs');
      await writeFile(file, code, 'utf-8');
      return { cmd: 'node', args: [file], cleanupFile: file };
    }
    case 'ts':
    case 'typescript': {
      const file = join(tmpDir, 'script.ts');
      await writeFile(file, code, 'utf-8');
      return { cmd: 'npx', args: ['tsx', file], cleanupFile: file };
    }
    case 'python':
    case 'py': {
      const file = join(tmpDir, 'script.py');
      await writeFile(file, code, 'utf-8');
      const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
      return { cmd: pyCmd, args: [file], cleanupFile: file };
    }
    case 'bash':
    case 'sh': {
      const isWin = process.platform === 'win32';
      const ext = isWin ? '.cmd' : '.sh';
      const file = join(tmpDir, `script${ext}`);
      await writeFile(file, code, 'utf-8');
      const shellCmd = isWin ? 'cmd.exe' : 'bash';
      const shellArgs = isWin ? ['/c', file] : [file];
      return { cmd: shellCmd, args: shellArgs, cleanupFile: file };
    }
    default:
      throw new Error(`Unsupported language: ${lang}`);
  }
}

/** Run a process with timeout */
function runProcess(
  cmd: string,
  args: string[],
  timeout: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      // Early truncation to prevent memory issues
      if (stdout.length > MAX_OUTPUT * 2) {
        stdout = stdout.slice(0, MAX_OUTPUT * 2);
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > MAX_OUTPUT * 2) {
        stderr = stderr.slice(0, MAX_OUTPUT * 2);
      }
    });

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
      reject(new Error('TIMEOUT'));
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return;
      resolve({ stdout, stderr, exitCode: code });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    // Close stdin immediately
    proc.stdin.end();
  });
}

/** Combine stdout and stderr into a single output */
function combineOutput(stdout: string, stderr: string): string {
  const parts: string[] = [];
  if (stdout.trim()) parts.push(stdout.trim());
  if (stderr.trim()) parts.push(`[stderr]\n${stderr.trim()}`);
  return parts.join('\n\n');
}

/** Format execution result for Telegram */
export function formatExecutionResult(result: ExecutionResult): string {
  const statusIcon = result.exitCode === 0 ? '✅' : result.exitCode === null ? '⏱️' : '❌';
  const lines = [
    `${statusIcon} *Code Execution* (${result.language})`,
    `Exit: ${result.exitCode ?? 'timeout'} | Duration: ${result.duration}ms`,
    '',
    '```',
    result.output,
    '```',
  ];

  if (result.truncated) {
    lines.push('\n_(output truncated)_');
  }

  return lines.join('\n');
}
