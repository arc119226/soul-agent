/**
 * Report Sync — EventBus listener that auto-generates Hexo posts
 * from agent reports and deploys them with debouncing.
 *
 * Flow:
 *   agent:task:completed → find full report in JSONL → reportToPost() → debounced deploy
 *
 * Debounce: 5 minutes after last report before deploying.
 * This batches concurrent reports into a single deploy cycle.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eventBus } from '../core/event-bus.js';
import { logger } from '../core/logger.js';
import { getTodayString } from '../core/timezone.js';
import { reportToPost, type AgentReport } from './report-to-post.js';
import { deployReportSite } from './report-deploy.js';

const REPORTS_DIR = join(process.cwd(), 'soul', 'agent-reports');
const DEPLOY_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes

let deployTimer: ReturnType<typeof setTimeout> | null = null;
let pendingCount = 0;
let isDeploying = false;

type TaskCompletedPayload = { agentName: string; taskId: string; result: string };

/** Find the full report entry from today's JSONL by taskId */
async function findReportByTaskId(agentName: string, taskId: string): Promise<AgentReport | null> {
  const today = getTodayString();
  const filePath = join(REPORTS_DIR, agentName, `${today}.jsonl`);
  try {
    const raw = await readFile(filePath, 'utf-8');
    // Search from the end (most recent first)
    const lines = raw.trim().split('\n').reverse();
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as AgentReport;
        if (entry.taskId === taskId) return entry;
      } catch { /* skip malformed */ }
    }
  } catch { /* file not found */ }
  return null;
}

async function handleTaskCompleted(data: TaskCompletedPayload): Promise<void> {
  const report = await findReportByTaskId(data.agentName, data.taskId);
  if (!report) {
    logger.debug('report-sync', `Report not found for task ${data.taskId}, skipping`);
    return;
  }

  // Skip very short/empty reports (same threshold as /report command)
  if (!report.result || report.result.trim().length < 30) {
    return;
  }

  const slug = await reportToPost(report);
  if (!slug) return;

  pendingCount++;
  logger.info('report-sync', `Post created: ${slug} (${pendingCount} pending deploy)`);

  // Reset deploy timer (debounce)
  if (deployTimer) clearTimeout(deployTimer);
  deployTimer = setTimeout(() => {
    triggerDeploy();
  }, DEPLOY_DEBOUNCE_MS);
}

async function triggerDeploy(): Promise<void> {
  if (isDeploying) return;
  isDeploying = true;
  const count = pendingCount;
  pendingCount = 0;

  try {
    logger.info('report-sync', `Deploying report site (${count} new posts)`);
    const result = await deployReportSite();
    if (result.ok) {
      logger.info('report-sync', 'Report site deployed successfully');
    } else {
      logger.warn('report-sync', `Deploy failed: ${result.message}`);
    }
  } finally {
    isDeploying = false;
    // If new reports came in during deploy, schedule another
    if (pendingCount > 0) {
      deployTimer = setTimeout(() => {
        triggerDeploy();
      }, DEPLOY_DEBOUNCE_MS);
    }
  }
}

let listening = false;

export function startReportSync(): void {
  if (listening) return;
  listening = true;
  eventBus.on('agent:task:completed', handleTaskCompleted);
  logger.info('report-sync', 'Report sync started (listening to agent:task:completed)');
}

export function stopReportSync(): void {
  if (!listening) return;
  listening = false;
  eventBus.off('agent:task:completed', handleTaskCompleted);
  if (deployTimer) {
    clearTimeout(deployTimer);
    deployTimer = null;
  }
  logger.info('report-sync', 'Report sync stopped');
}
