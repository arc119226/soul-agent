/**
 * Bootstrap Phase 3 — Non-Critical Subsystems
 *
 * Each subsystem is wrapped in try/catch — failure only warns.
 * Includes: metrics, narrative listener, feedback loop, chat memory,
 * agents, plugins, skills, memory search, health API, approval server,
 * state machine, ELU monitor, heartbeat.
 */

import { logger } from '../core/logger.js';
import { shutdown } from '../core/shutdown.js';
import { config } from '../config.js';
import type { Bot } from 'grammy';
import type { BotContext } from '../bot.js';

export async function initSubsystems(bot: Bot<BotContext>): Promise<void> {
  // Metrics collector (EventBus-driven, zero-coupling)
  try {
    const { attachMetricsCollector, detachMetricsCollector, flushMetrics } = await import('../core/metrics-collector.js');
    attachMetricsCollector();
    shutdown.register('flush-metrics', async () => {
      await flushMetrics();
      detachMetricsCollector();
    });
    await logger.info('startup', 'Metrics collector attached');
  } catch (err) {
    await logger.warn('startup', 'Metrics collector failed (non-fatal)', err);
  }

  // Narrative lifecycle listener (bridges events → narrative.jsonl for learning loop)
  try {
    const { setupNarrativeListener, disposeNarrativeListener } = await import('../lifecycle/narrative-listener.js');
    setupNarrativeListener();
    shutdown.register('dispose-narrative-listener', () => disposeNarrativeListener());
    await logger.info('startup', 'Narrative lifecycle listener registered');
  } catch (err) {
    await logger.warn('startup', 'Narrative listener failed (non-fatal)', err);
  }

  // Feedback loop (bridges events → vitals, learning, goals, capabilities)
  try {
    const { setupFeedbackLoop, disposeFeedbackLoop } = await import('../metacognition/feedback-loop.js');
    setupFeedbackLoop();
    shutdown.register('dispose-feedback-loop', () => disposeFeedbackLoop());
    await logger.info('startup', 'Feedback loop registered');
  } catch (err) {
    await logger.warn('startup', 'Feedback loop failed (non-fatal)', err);
  }

  // Chat memory listener (must be before message handler starts processing)
  try {
    const { setupChatMemoryListener } = await import('../memory/chat-memory-listener.js');
    setupChatMemoryListener();
    await logger.info('startup', 'Chat memory listener registered');
  } catch (err) {
    await logger.warn('startup', 'Chat memory listener failed (non-fatal)', err);
  }

  // Agent system
  try {
    const { initAgents, disposeAgents } = await import('../agents/init.js');
    initAgents();
    shutdown.register('dispose-agents', () => disposeAgents());
    await logger.info('startup', 'Agent system initialized');
  } catch (err) {
    await logger.warn('startup', 'Agent system init failed (non-fatal)', err);
  }

  // Plugins
  try {
    const { loadAllPlugins, disposeAllPlugins } = await import('../plugins/plugin-loader.js');
    await loadAllPlugins();
    shutdown.register('dispose-plugins', () => disposeAllPlugins());
    await logger.info('startup', 'Plugins loaded');
  } catch (err) {
    await logger.warn('startup', 'Plugin loading failed (non-fatal)', err);
  }

  // Skill index (builds keyword index for Markdown skills in soul/skills/)
  try {
    const { buildSkillIndex } = await import('../skills/skill-loader.js');
    await buildSkillIndex();
  } catch (err) {
    await logger.warn('startup', 'Skill index build failed (non-fatal)', err);
  }

  // Memory search index (BM25 inverted index over all soul/ data)
  try {
    const { initSearchIndex } = await import('../memory/search-index.js');
    await initSearchIndex();
    await logger.info('startup', 'Memory search index initialized');
  } catch (err) {
    await logger.warn('startup', 'Memory search index failed (non-fatal)', err);
  }

  // Health API (optional — enabled when HEALTH_API_PORT > 0)
  if (config.HEALTH_API_PORT > 0) {
    try {
      const { startHealthApi, stopHealthApi } = await import('../web/health-api.js');
      startHealthApi(config.HEALTH_API_PORT);
      shutdown.register('stop-health-api', () => stopHealthApi());
      await logger.info('startup', `Health API started on port ${config.HEALTH_API_PORT}`);
    } catch (err) {
      await logger.warn('startup', 'Health API failed to start (non-fatal)', err);
    }
  }

  // Approval server
  try {
    const { startApprovalServer, stopApprovalServer } = await import('../claude/approval-server.js');
    const server = startApprovalServer();
    if (server) {
      shutdown.register('stop-approval-server', () => stopApprovalServer());
      await logger.info('startup', `Approval server started on port ${config.APPROVAL_PORT}`);
    }
  } catch (err) {
    await logger.warn('startup', 'Approval server failed to start (non-fatal)', err);
  }

  // Approval bridge (Telegram ↔ approval server)
  try {
    const { wireApprovalToTelegram } = await import('../telegram/approval-bridge.js');
    wireApprovalToTelegram(bot);
  } catch (err) {
    await logger.warn('startup', 'Approval bridge failed (non-fatal)', err);
  }

  // State machine
  try {
    const { setInitialState } = await import('../lifecycle/state-machine.js');
    setInitialState('active');
    await logger.info('startup', 'State: active');
  } catch (err) {
    await logger.warn('startup', 'State machine init failed (non-fatal)', err);
  }

  // Cost anomaly detector (per-agent Z-score alerting)
  try {
    const { attachCostAnomalyDetector, detachCostAnomalyDetector } = await import('../agents/monitoring/cost-anomaly.js');
    attachCostAnomalyDetector();
    shutdown.register('detach-cost-anomaly', () => detachCostAnomalyDetector());
    await logger.info('startup', 'Cost anomaly detector attached');
  } catch (err) {
    await logger.warn('startup', 'Cost anomaly detector failed (non-fatal)', err);
  }

  // ELU monitor
  try {
    const { initELU } = await import('../lifecycle/elu-monitor.js');
    await initELU();
    await logger.info('startup', 'ELU monitor initialized');
  } catch (err) {
    await logger.warn('startup', 'ELU monitor init failed (non-fatal)', err);
  }

  // Heartbeat
  try {
    const { startHeartbeat, stopHeartbeat } = await import('../lifecycle/heartbeat.js');
    startHeartbeat();
    shutdown.register('stop-heartbeat', () => stopHeartbeat());
    await logger.info('startup', 'Heartbeat started');
  } catch (err) {
    await logger.warn('startup', 'Heartbeat failed to start (non-fatal)', err);
  }
}
