/**
 * Process wrapper for auto-restart support.
 * Spawns src/index.ts via tsx as a child process.
 * Exit code 42 → wait 2s → restart (evolution molting).
 * Exit code 0 → stop (shutdown/sleep).
 * Other codes → stop (error, needs manual intervention).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RESTART_CODE = 42;
const RESTART_DELAY_MS = 2000;
const ENTRY = join(__dirname, 'src', 'index.ts');

let child: ChildProcess | null = null;

function startBot(): void {
  console.log(`[Wrapper] Starting bot: tsx ${ENTRY}`);

  child = spawn('npx', ['tsx', ENTRY], {
    stdio: 'inherit',
    cwd: __dirname,
    shell: true,
    env: { ...process.env },
  });

  child.on('exit', (code, signal) => {
    child = null;

    if (code === RESTART_CODE) {
      console.log(
        `[Wrapper] Bot exited with code ${RESTART_CODE} (molting) — restarting in ${RESTART_DELAY_MS / 1000}s...`
      );
      setTimeout(startBot, RESTART_DELAY_MS);
    } else if (signal) {
      console.log(`[Wrapper] Bot killed by signal ${signal}. Exiting.`);
      process.exit(1);
    } else {
      const label =
        code === 0
          ? 'sleep'
          : 'error';
      console.log(`[Wrapper] Bot exited with code ${code} (${label}). Exiting.`);
      process.exit(code ?? 0);
    }
  });

  child.on('error', (err) => {
    console.error('[Wrapper] Failed to start bot:', err.message);
    process.exit(1);
  });
}

// Forward signals to child
function forwardSignal(signal: NodeJS.Signals): void {
  if (child) {
    child.kill(signal);
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', () => forwardSignal('SIGINT'));
if (process.platform !== 'win32') {
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));
}

startBot();
