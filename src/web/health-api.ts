/**
 * Health API — lightweight HTTP server for system observability + dashboard.
 *
 * Pages:
 *   GET /         → Overview dashboard (system health, queue, agents)
 *   GET /chains   → Task Chain org chart (agent-centric workload view)
 *   GET /reports  → Report viewer (markdown rendering)
 *
 * API Endpoints:
 *   GET  /api/health                → System health metrics
 *   GET  /api/agents                → All agent configs + status
 *   GET  /api/agents/:name/trends   → Trend data for a specific agent
 *   GET  /api/agents/:name/tasks    → Single agent's task list
 *   GET  /api/agents/:name/config   → Agent configuration
 *   PUT  /api/agents/:name/config   → Update agent configuration
 *   GET  /api/agents/workload       → Agent-centric workload overview
 *   GET  /api/agents/flowmap        → HANDOFF flow statistics
 *   GET  /api/queue                 → Current task queue
 *   GET  /api/costs                 → Per-agent cost stats + anomaly data
 *   GET  /api/circuit-breakers      → All circuit breaker states
 *   GET  /api/reports               → Paginated report listing
 *   GET  /api/reports/search?q=     → Full-text report search
 *   GET  /api/reports/:id           → Full report detail
 *   GET  /api/chains/:rootId        → Full chain tree for a root task
 *
 * Uses Node.js native http module (zero dependencies).
 * Configurable port via HEALTH_API_PORT env var (default: disabled).
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { logger } from '../core/logger.js';
import { getOverviewHTML } from './dashboard-overview.js';
import { getChainsHTML } from './dashboard-chains.js';
import { getReportsHTML } from './dashboard-reports.js';
import {
  gatherAgentWorkload, gatherAgentTasks, gatherChainDetail,
  gatherFlowMap, getAgentConfig, updateAgentConfig,
} from './api-chains.js';
import { gatherReportList, gatherReportDetail, gatherReportSearch } from './api-reports.js';

let server: Server | null = null;

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  lifecycle: {
    state: string;
    stateDuration: number;
    dailyPhase: string;
  };
  performance: {
    elu: number;
    eluAverage: number;
    fatigueScore: number;
    fatigueLevel: string;
    heapUsedMB: number;
    heapGrowthRate: number;
    eventsPerMinute: number;
    rssMB: number;
  };
  agents: {
    pending: number;
    running: number;
    total: number;
  };
  evolution: {
    circuitBreakerState: string;
    cooldownRemainingMs: number;
  };
}

// ── JSON Response Helper ─────────────────────────────────────────────

function jsonResponse(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function htmlResponse(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(html);
}

// ── Data Gatherers ───────────────────────────────────────────────────

async function gatherHealth(): Promise<HealthResponse> {
  let state = 'unknown';
  let stateDuration = 0;
  try {
    const sm = await import('../lifecycle/state-machine.js');
    state = sm.getCurrentState();
    stateDuration = sm.getStateDuration();
  } catch { /* subsystem unavailable */ }

  let dailyPhase = 'unknown';
  try {
    const dr = await import('../lifecycle/daily-rhythm.js');
    dailyPhase = dr.getDailyPhase().phase;
  } catch { /* subsystem unavailable */ }

  let elu = 0;
  let eluAverage = 0;
  try {
    const em = await import('../lifecycle/elu-monitor.js');
    elu = em.getELU();
    eluAverage = em.getELUAverage();
  } catch { /* subsystem unavailable */ }

  let fatigueScore = 0;
  let fatigueLevel = 'unknown';
  let heapUsedMB = 0;
  let heapGrowthRate = 0;
  let eventsPerMinute = 0;
  try {
    const fs = await import('../lifecycle/fatigue-score.js');
    const fatigue = fs.calculateFatigue();
    fatigueScore = fatigue.score;
    fatigueLevel = fatigue.level;
    heapUsedMB = fatigue.heapUsedMB;
    heapGrowthRate = fatigue.heapGrowthRate;
    eventsPerMinute = fatigue.eventsPerMinute;
  } catch { /* subsystem unavailable */ }

  const rssMB = Math.round(process.memoryUsage().rss / (1024 * 1024) * 10) / 10;

  let agentPending = 0;
  let agentRunning = 0;
  let agentTotal = 0;
  try {
    const ws = await import('../agents/worker-scheduler.js');
    const qs = await ws.getQueueStatus();
    agentPending = qs.pending;
    agentRunning = qs.running;
    agentTotal = qs.total;
  } catch { /* subsystem unavailable */ }

  let cbState = 'unknown';
  let cbCooldown = 0;
  try {
    const cb = await import('../evolution/circuit-breaker.js');
    const info = cb.getCircuitBreakerInfo();
    cbState = info.state;
    cbCooldown = info.cooldownRemainingMs;
  } catch { /* subsystem unavailable */ }

  let status: 'ok' | 'degraded' | 'unhealthy' = 'ok';
  if (fatigueLevel === 'drained' || cbState === 'open') {
    status = 'unhealthy';
  } else if (fatigueLevel === 'throttled' || cbState === 'half-open') {
    status = 'degraded';
  }

  return {
    status,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    lifecycle: { state, stateDuration, dailyPhase },
    performance: {
      elu: Math.round(elu * 10000) / 10000,
      eluAverage: Math.round(eluAverage * 10000) / 10000,
      fatigueScore, fatigueLevel,
      heapUsedMB, heapGrowthRate, rssMB,
      eventsPerMinute,
    },
    agents: { pending: agentPending, running: agentRunning, total: agentTotal },
    evolution: { circuitBreakerState: cbState, cooldownRemainingMs: cbCooldown },
  };
}

async function gatherAgents(): Promise<unknown[]> {
  try {
    const { loadAllAgentConfigs } = await import('../agents/config/agent-config.js');
    const configs = await loadAllAgentConfigs();
    return configs.map((cfg) => ({
      name: cfg.name,
      enabled: cfg.enabled,
      schedule: cfg.schedule,
      model: cfg.model,
      maxTurns: cfg.maxTurns,
      timeout: cfg.timeout,
      dailyCostLimit: cfg.dailyCostLimit,
      totalCostToday: cfg.totalCostToday ?? 0,
      runsToday: cfg.runsToday ?? 0,
      totalRuns: cfg.totalRuns ?? 0,
      successRate: cfg.valueScore ?? 0,
      lastRun: cfg.lastRun,
      avgDurationMs: cfg.avgDurationMs ?? 0,
      failureCount7d: cfg.failureCount7d ?? 0,
      lastFailureReason: cfg.lastFailureReason,
      pauseUntil: cfg.pauseUntil,
      role: cfg.role,
    }));
  } catch {
    return [];
  }
}

async function gatherQueue(): Promise<unknown> {
  try {
    const ws = await import('../agents/worker-scheduler.js');
    const qs = await ws.getQueueStatus();
    return {
      pending: qs.pending,
      running: qs.running,
      blocked: qs.blocked,
      total: qs.total,
      tasks: qs.tasks.map((t) => ({
        id: t.id,
        agentName: t.agentName,
        status: t.status,
        priority: t.priority,
        createdAt: t.createdAt,
        startedAt: t.startedAt,
        source: t.source,
        chainDepth: t.chainDepth ?? 0,
        retryCount: t.retryCount ?? 0,
      })),
    };
  } catch {
    return { pending: 0, running: 0, blocked: 0, total: 0, tasks: [] };
  }
}

async function gatherCosts(): Promise<unknown> {
  try {
    const { getAllCostStats } = await import('../agents/monitoring/cost-anomaly.js');
    const costStats = getAllCostStats();

    const { loadAllAgentConfigs } = await import('../agents/config/agent-config.js');
    const configs = await loadAllAgentConfigs();

    const agents: Record<string, unknown> = {};
    for (const cfg of configs) {
      if (!cfg.enabled) continue;
      const stats = costStats[cfg.name];
      agents[cfg.name] = {
        totalCostToday: cfg.totalCostToday ?? 0,
        dailyCostLimit: cfg.dailyCostLimit ?? 0,
        runsToday: cfg.runsToday ?? 0,
        anomalyStats: stats ?? null,
      };
    }

    const totalToday = configs.reduce((sum, c) => sum + (c.totalCostToday ?? 0), 0);
    return { totalCostToday: totalToday, agents };
  } catch {
    return { totalCostToday: 0, agents: {} };
  }
}

async function gatherCircuitBreakers(): Promise<unknown> {
  const breakers: Record<string, unknown> = {};

  try {
    const cb = await import('../evolution/circuit-breaker.js');
    const info = cb.getCircuitBreakerInfo();
    breakers.evolution = info;
  } catch { /* subsystem unavailable */ }

  try {
    const wcb = await import('../agents/monitoring/worker-circuit-breaker.js');
    const info = wcb.getWorkerCircuitInfo();
    breakers.worker = info;
  } catch { /* subsystem unavailable */ }

  return breakers;
}

async function gatherAgentTrends(agentName: string): Promise<unknown> {
  try {
    const { getAgentTrends } = await import('../agents/monitoring/stats-snapshot.js');
    return await getAgentTrends(agentName, 14);
  } catch (err) {
    return { error: (err as Error).message };
  }
}

// ── Request Body Parser ──────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

// ── Route Handler ────────────────────────────────────────────────────

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawUrl = req.url ?? '/';
  const [pathname, queryString] = rawUrl.split('?', 2);
  const params = new URLSearchParams(queryString ?? '');

  // CORS preflight for PUT requests
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // ── HTML Pages ──────────────────────────────────────────────────

  if (req.method === 'GET' && pathname === '/') {
    htmlResponse(res, getOverviewHTML());
    return;
  }

  if (req.method === 'GET' && pathname === '/chains') {
    htmlResponse(res, getChainsHTML());
    return;
  }

  if (req.method === 'GET' && pathname === '/reports') {
    htmlResponse(res, getReportsHTML());
    return;
  }

  // ── Existing API Endpoints ──────────────────────────────────────

  if (req.method === 'GET' && pathname === '/api/health') {
    try {
      const health = await gatherHealth();
      jsonResponse(res, health, health.status === 'unhealthy' ? 503 : 200);
    } catch (err) {
      jsonResponse(res, { status: 'error', message: 'Internal error' }, 500);
      logger.warn('HealthAPI', 'Failed to gather health', err);
    }
    return;
  }

  // Agent workload (must be before /api/agents to avoid prefix match)
  if (req.method === 'GET' && pathname === '/api/agents/workload') {
    jsonResponse(res, await gatherAgentWorkload());
    return;
  }

  // Agent flowmap
  if (req.method === 'GET' && pathname === '/api/agents/flowmap') {
    jsonResponse(res, gatherFlowMap());
    return;
  }

  // Agent trends
  const trendsMatch = pathname!.match(/^\/api\/agents\/([^/]+)\/trends$/);
  if (req.method === 'GET' && trendsMatch) {
    jsonResponse(res, await gatherAgentTrends(decodeURIComponent(trendsMatch[1]!)));
    return;
  }

  // Agent tasks
  const agentTasksMatch = pathname!.match(/^\/api\/agents\/([^/]+)\/tasks$/);
  if (req.method === 'GET' && agentTasksMatch) {
    const agentName = decodeURIComponent(agentTasksMatch[1]!);
    const limit = parseInt(params.get('limit') ?? '20', 10);
    jsonResponse(res, gatherAgentTasks(agentName, limit));
    return;
  }

  // Agent config (GET + PUT)
  const agentConfigMatch = pathname!.match(/^\/api\/agents\/([^/]+)\/config$/);
  if (agentConfigMatch) {
    const agentName = decodeURIComponent(agentConfigMatch[1]!);
    if (req.method === 'GET') {
      const cfg = await getAgentConfig(agentName);
      if (cfg) { jsonResponse(res, cfg); } else { jsonResponse(res, { error: 'Agent not found' }, 404); }
      return;
    }
    if (req.method === 'PUT') {
      try {
        const body = await readBody(req);
        const patch = JSON.parse(body) as Record<string, unknown>;
        const result = await updateAgentConfig(agentName, patch);
        jsonResponse(res, result, result.ok ? 200 : 400);
      } catch (err) {
        jsonResponse(res, { ok: false, error: (err as Error).message }, 400);
      }
      return;
    }
  }

  // Agents list
  if (req.method === 'GET' && pathname === '/api/agents') {
    jsonResponse(res, await gatherAgents());
    return;
  }

  // Queue
  if (req.method === 'GET' && pathname === '/api/queue') {
    jsonResponse(res, await gatherQueue());
    return;
  }

  // Costs
  if (req.method === 'GET' && pathname === '/api/costs') {
    jsonResponse(res, await gatherCosts());
    return;
  }

  // Circuit breakers
  if (req.method === 'GET' && pathname === '/api/circuit-breakers') {
    jsonResponse(res, await gatherCircuitBreakers());
    return;
  }

  // ── New API Endpoints ───────────────────────────────────────────

  // Report search (must be before /api/reports/:id)
  if (req.method === 'GET' && pathname === '/api/reports/search') {
    const q = params.get('q') ?? '';
    const limit = parseInt(params.get('limit') ?? '20', 10);
    jsonResponse(res, await gatherReportSearch(q, limit));
    return;
  }

  // Report detail
  const reportDetailMatch = pathname!.match(/^\/api\/reports\/(\d+)$/);
  if (req.method === 'GET' && reportDetailMatch) {
    const id = parseInt(reportDetailMatch[1]!, 10);
    const detail = gatherReportDetail(id);
    if (detail) { jsonResponse(res, detail); } else { jsonResponse(res, { error: 'Report not found' }, 404); }
    return;
  }

  // Report list
  if (req.method === 'GET' && pathname === '/api/reports') {
    const opts = {
      agent: params.get('agent') ?? undefined,
      from: params.get('from') ?? undefined,
      to: params.get('to') ?? undefined,
      page: parseInt(params.get('page') ?? '1', 10),
      limit: parseInt(params.get('limit') ?? '20', 10),
    };
    jsonResponse(res, gatherReportList(opts));
    return;
  }

  // Chain detail
  const chainMatch = pathname!.match(/^\/api\/chains\/(.+)$/);
  if (req.method === 'GET' && chainMatch) {
    const rootId = decodeURIComponent(chainMatch[1]!);
    jsonResponse(res, gatherChainDetail(rootId));
    return;
  }

  // 404
  jsonResponse(res, { error: 'Not found' }, 404);
}

// ── Server Lifecycle ─────────────────────────────────────────────────

/**
 * Start the health API HTTP server on the given port.
 * Binds to 0.0.0.0 so Windows host can reach WSL guest.
 * Set HEALTH_API_BIND=127.0.0.1 to restrict to localhost only.
 */
export function startHealthApi(port: number): Server {
  if (server) return server;

  const bind = process.env.HEALTH_API_BIND || '0.0.0.0';

  server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error' }));
      logger.warn('HealthAPI', 'Unhandled error', err);
    });
  });

  server.listen(port, bind, () => {
    logger.info('HealthAPI', `Dashboard: http://${bind}:${port}/ | API: http://${bind}:${port}/api/health`);
  });

  server.on('error', (err) => {
    logger.warn('HealthAPI', `Failed to start on port ${port}`, err);
    server = null;
  });

  return server;
}

/**
 * Stop the health API server.
 */
export function stopHealthApi(): void {
  if (server) {
    server.close();
    server = null;
    logger.info('HealthAPI', 'Health API stopped');
  }
}

/** Exported for testing */
export { gatherHealth };
