/**
 * Entry point — Startup sequence orchestrator.
 *
 * Principle: Memory first, then body.
 *
 * Phase 1: Load soul (memory, identity, vitals, integrity, auth)
 * Phase 2: Create bot (middleware, commands, message handler)
 * Phase 3: Register shutdown handlers
 * Phase 4: Initialize non-critical subsystems
 * Phase 5: Start polling, engines, and online notification
 *
 * Each phase is in a separate module under src/bootstrap/ for
 * independent testing and isolated failure domains.
 */

import dns from 'node:dns';

// Force IPv4 first — WSL2 often has broken IPv6 connectivity
dns.setDefaultResultOrder('ipv4first');

import { logger } from './core/logger.js';
import { loadSoul } from './bootstrap/phase1-soul.js';
import { createAndConfigureBot } from './bootstrap/phase2-bot.js';
import { registerShutdownHandlers } from './bootstrap/shutdown.js';
import { initSubsystems } from './bootstrap/phase3-subsystems.js';
import { startServices } from './bootstrap/phase4-startup.js';
import type { RunnerHandle } from '@grammyjs/runner';

async function main(): Promise<void> {
  await logger.info('startup', '=== Metacognitive Bot Starting ===');

  // Phase 1: Load soul (critical — fatal on failure)
  const soul = await loadSoul();

  // Phase 2: Create and configure bot
  const bot = await createAndConfigureBot();

  // Phase 3: Register shutdown handlers
  let runnerHandle: RunnerHandle | null = null;
  registerShutdownHandlers(bot, () => runnerHandle);

  // Phase 4: Initialize non-critical subsystems
  await initSubsystems(bot);

  // Phase 5: Start polling + engines + notification
  runnerHandle = await startServices(bot, soul);
}

main().catch(async (err) => {
  await logger.error('startup', 'Fatal startup error', err);
  process.exit(1);
});
