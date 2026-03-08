/**
 * Bootstrap Phase 4 — Services & Polling
 *
 * Starts Telegram polling, first boot ritual, proactive engine,
 * evolution, worker scheduler, report sync, and online notification.
 */

import { logger } from '../core/logger.js';
import { eventBus } from '../core/event-bus.js';
import { shutdown } from '../core/shutdown.js';
import { config } from '../config.js';
import { run, type RunnerHandle } from '@grammyjs/runner';
import type { Bot } from 'grammy';
import type { BotContext } from '../bot.js';
import type { SoulLoadResult } from './phase1-soul.js';

export async function startServices(
  bot: Bot<BotContext>,
  soul: SoulLoadResult,
): Promise<RunnerHandle> {
  // Phase 6: Delete any stale webhook and start concurrent polling
  await logger.info('startup', 'Starting Telegram polling...');
  await bot.api.deleteWebhook({ drop_pending_updates: true });
  await logger.info('startup', 'Webhook cleared, starting concurrent runner...');

  // Initialize bot info before run() so bot.botInfo is available immediately
  await bot.init();
  const runnerHandle = run(bot);

  const botInfo = bot.botInfo;
  await logger.info('startup', `Bot started: @${botInfo.username} (id: ${botInfo.id})`);
  await eventBus.emit('bot:ready', {});

  // Phase 7: First boot ritual
  if (soul.firstBoot && config.ADMIN_USER_ID) {
    try {
      const { performFirstBoot } = await import('../lifecycle/first-boot.js');
      await performFirstBoot(bot, config.ADMIN_USER_ID);
    } catch (err) {
      await logger.warn('startup', 'First boot ritual failed (non-fatal)', err);
    }
  }

  // Phase 7.5: Load schedule engine state + start proactive engine
  try {
    const { scheduleEngine } = await import('../core/schedule-engine.js');
    await scheduleEngine.loadState();
  } catch (err) {
    await logger.warn('startup', 'Schedule engine state load failed (non-fatal)', err);
  }
  try {
    const { startProactiveEngine, stopProactiveEngine } = await import('../proactive/engine.js');
    await startProactiveEngine(bot);
    shutdown.register('stop-proactive-engine', () => stopProactiveEngine());
  } catch (err) {
    await logger.warn('startup', 'Proactive engine failed to start (non-fatal)', err);
  }

  // Phase 7.5b: Achievement notifier
  try {
    const { startAchievementNotifier, stopAchievementNotifier } = await import('../proactive/achievement-notifier.js');
    startAchievementNotifier(bot);
    shutdown.register('stop-achievement-notifier', () => stopAchievementNotifier());
    await logger.info('startup', 'Achievement notifier started');
  } catch (err) {
    await logger.warn('startup', 'Achievement notifier failed to start (non-fatal)', err);
  }

  // Phase 7.5c: Upgrade notifier
  try {
    const { startUpgradeNotifier, stopUpgradeNotifier } = await import('../proactive/upgrade-notifier.js');
    startUpgradeNotifier(bot);
    shutdown.register('stop-upgrade-notifier', () => stopUpgradeNotifier());
    await logger.info('startup', 'Upgrade notifier started');
  } catch (err) {
    await logger.warn('startup', 'Upgrade notifier failed to start (non-fatal)', err);
  }

  // Phase 7.5d: Upgrade advisor scheduler
  try {
    const { registerUpgradeCheckScheduler } = await import('../skills/upgrade-advisor.js');
    registerUpgradeCheckScheduler();
    await logger.info('startup', 'Upgrade check scheduler registered');
  } catch (err) {
    await logger.warn('startup', 'Upgrade check scheduler failed to register (non-fatal)', err);
  }

  // Phase 7.5e: Plugin degradation monitor
  try {
    const { startPluginDegradation, stopPluginDegradation } = await import('../plugins/plugin-degradation.js');
    startPluginDegradation(bot);
    shutdown.register('stop-plugin-degradation', () => stopPluginDegradation());
    await logger.info('startup', 'Plugin degradation monitor started');
  } catch (err) {
    await logger.warn('startup', 'Plugin degradation monitor failed to start (non-fatal)', err);
  }

  // Phase 7.5f: Proactive pattern observer
  try {
    const { startProactiveObserver, stopProactiveObserver } = await import('../metacognition/proactive-observer.js');
    startProactiveObserver();
    shutdown.register('stop-proactive-observer', () => stopProactiveObserver());
    await logger.info('startup', 'Proactive pattern observer started');
  } catch (err) {
    await logger.warn('startup', 'Proactive pattern observer failed to start (non-fatal)', err);
  }

  // Phase 7.5g: Escalation notifier
  try {
    const { startEscalationNotifier, stopEscalationNotifier } = await import('../proactive/escalation-notifier.js');
    startEscalationNotifier(bot);
    shutdown.register('stop-escalation-notifier', () => stopEscalationNotifier());
    await logger.info('startup', 'Escalation notifier started');
  } catch (err) {
    await logger.warn('startup', 'Escalation notifier failed to start (non-fatal)', err);
  }

  // Phase 7.6a: Load evolution state (goals, capabilities, circuit-breaker)
  try {
    const { loadGoals } = await import('../evolution/goals.js');
    await loadGoals();
    const { loadCapabilities } = await import('../evolution/capabilities.js');
    await loadCapabilities();
    const { loadCircuitBreaker } = await import('../evolution/circuit-breaker.js');
    await loadCircuitBreaker();
    const { loadWorkerCircuitBreaker } = await import('../agents/monitoring/worker-circuit-breaker.js');
    await loadWorkerCircuitBreaker();
    await logger.info('startup', 'Evolution state loaded (goals, capabilities, circuit-breakers)');
  } catch (err) {
    await logger.warn('startup', 'Evolution state loading failed (non-fatal)', err);
  }

  // Phase 7.6b: Auto-evolution scheduler
  try {
    const { startAutoEvolve, stopAutoEvolve } = await import('../evolution/auto-evolve.js');
    startAutoEvolve();
    shutdown.register('stop-auto-evolve', () => stopAutoEvolve());
    await logger.info('startup', 'Auto-evolution scheduler started');
  } catch (err) {
    await logger.warn('startup', 'Auto-evolution scheduler failed to start (non-fatal)', err);
  }

  // Phase 7.7: Worker scheduler
  try {
    const { startWorkerScheduler, stopWorkerScheduler } = await import('../agents/worker-scheduler.js');
    startWorkerScheduler();
    shutdown.register('stop-worker-scheduler', () => stopWorkerScheduler());
    await logger.info('startup', 'Worker scheduler started');
  } catch (err) {
    await logger.warn('startup', 'Worker scheduler failed to start (non-fatal)', err);
  }

  // Phase 7.7b: Report site sync
  try {
    const { startReportSync, stopReportSync } = await import('../report-site/report-sync.js');
    startReportSync();
    shutdown.register('stop-report-sync', () => stopReportSync());
    await logger.info('startup', 'Report site sync started');
  } catch (err) {
    await logger.warn('startup', 'Report site sync failed to start (non-fatal)', err);
  }

  // Phase 7.8: Exploration report listener
  try {
    const { initExplorationReportListener } = await import('../metacognition/exploration-report.js');
    initExplorationReportListener();
  } catch (err) {
    await logger.warn('startup', 'Exploration report listener failed to start (non-fatal)', err);
  }

  // Phase 8: Notify owner that bot is online
  if (config.ADMIN_USER_ID && !soul.firstBoot) {
    try {
      const { getVitals } = await import('../identity/vitals.js');
      const vitals = await getVitals();
      const energyPct = Math.round(vitals.energy_level * 100);
      const authLine = soul.authReport
        ? `\nClaude: CLI ${soul.authReport.cliAvailable ? '✓' : '⚠️ 未找到'} | API Key ${soul.authReport.apiKeyPresent ? '✓' : '未設定'}`
        : '';
      await bot.api.sendMessage(
        config.ADMIN_USER_ID,
        `我上線了！精力 ${energyPct}%，心情「${vitals.mood}」，準備好了 😊${authLine}`,
      );
      await logger.info('startup', 'Sent online notification to admin');
    } catch (err) {
      await logger.warn('startup', 'Failed to send online notification (non-fatal)', err);
    }
  }

  return runnerHandle;
}
