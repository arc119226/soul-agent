/**
 * Bootstrap — Shutdown Handler Registration
 *
 * Registers core shutdown handlers in LIFO order:
 *   stop-bot → flush-and-seal → close-database
 */

import { shutdown } from '../core/shutdown.js';
import { writer } from '../core/debounced-writer.js';
import type { Bot } from 'grammy';
import type { BotContext } from '../bot.js';
import type { RunnerHandle } from '@grammyjs/runner';

/**
 * Register core shutdown handlers.
 * @param bot - The grammY bot instance
 * @param getRunnerHandle - Getter for the runner handle (set later during polling start)
 */
export function registerShutdownHandlers(
  bot: Bot<BotContext>,
  getRunnerHandle: () => RunnerHandle | null,
): void {
  shutdown.register('close-database', async () => {
    try {
      const { closeDb } = await import('../core/database.js');
      closeDb();
    } catch { /* non-critical */ }
  });

  shutdown.register('flush-and-seal', async () => {
    // 1. Flush all pending debounced writes so disk state is current
    await writer.flush();
    // 2. Compute fingerprint from now-current disk state
    try {
      const { computeSoulFingerprint } = await import('../safety/soul-integrity.js');
      const { setFingerprint } = await import('../identity/vitals.js');
      const fp = await computeSoulFingerprint();
      if (fp.ok) {
        await setFingerprint(fp.value.hash, fp.value.files);
        // 3. Write vitals immediately (setFingerprint uses writer.schedule which is debounced)
        await writer.flush();
      }
    } catch { /* non-critical */ }
  });

  shutdown.register('stop-bot', async () => {
    const handle = getRunnerHandle();
    if (handle) await handle.stop();
    else bot.stop();
  });
}
