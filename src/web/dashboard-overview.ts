/**
 * Overview Dashboard page — extracted from health-api.ts.
 * Shows system health, circuit breakers, task queue, agents, and costs.
 */

import { wrapPage } from './dashboard-shared.js';

export function getOverviewHTML(): string {
  const bodyHTML = `
<h1>Bot Agent Dashboard <span class="refresh" id="lastRefresh"></span></h1>
<div id="error"></div>

<h2>System Health</h2>
<div class="grid" id="health-cards"></div>

<h2>Circuit Breakers</h2>
<div class="grid" id="cb-cards"></div>

<h2>Task Queue</h2>
<div class="grid" id="queue-cards"></div>
<table id="queue-table"><thead><tr><th>ID</th><th>Agent</th><th>Status</th><th>Priority</th><th>Source</th><th>Created</th></tr></thead><tbody></tbody></table>

<h2>Agents</h2>
<table id="agent-table"><thead><tr><th>Name</th><th>Status</th><th>Schedule</th><th>Runs Today</th><th>Cost Today</th><th>Limit</th><th>Fail 7d</th><th>Avg Duration</th><th>Last Run</th></tr></thead><tbody></tbody></table>

<h2>Cost Overview</h2>
<div class="grid" id="cost-cards"></div>`;

  const bodyJS = `
async function refresh() {
  try {
    const [health, agents, queue, costs, cbs] = await Promise.all([
      fetchJson('/api/health'),
      fetchJson('/api/agents'),
      fetchJson('/api/queue'),
      fetchJson('/api/costs'),
      fetchJson('/api/circuit-breakers'),
    ]);

    document.getElementById('health-cards').innerHTML = [
      { label: 'Status', value: health.status, cls: health.status },
      { label: 'Uptime', value: fmtDuration(health.uptime * 1000) },
      { label: 'State', value: health.lifecycle.state },
      { label: 'Phase', value: health.lifecycle.dailyPhase },
      { label: 'ELU', value: (health.performance.elu * 100).toFixed(1) + '%' },
      { label: 'Fatigue', value: health.performance.fatigueLevel + ' (' + health.performance.fatigueScore + ')' },
      { label: 'RSS', value: health.performance.rssMB + ' MB' },
      { label: 'Heap', value: health.performance.heapUsedMB.toFixed(1) + ' MB' },
    ].map(c => '<div class="card"><div class="label">' + c.label + '</div><div class="value ' + (c.cls||'') + '">' + c.value + '</div></div>').join('');

    const cbHtml = [];
    if (cbs.evolution) cbHtml.push({ label: 'Evolution CB', value: cbs.evolution.state, cls: cbs.evolution.state === 'closed' ? 'ok' : 'unhealthy' });
    if (cbs.worker) cbHtml.push({ label: 'Worker CB', value: cbs.worker.state, cls: cbs.worker.state === 'closed' ? 'ok' : 'unhealthy' });
    document.getElementById('cb-cards').innerHTML = cbHtml.map(c => '<div class="card"><div class="label">' + c.label + '</div><div class="value ' + c.cls + '">' + c.value + '</div></div>').join('') || '<div class="card"><div class="label">No data</div></div>';

    document.getElementById('queue-cards').innerHTML = [
      { label: 'Pending', value: queue.pending },
      { label: 'Running', value: queue.running },
      { label: 'Blocked', value: queue.blocked },
      { label: 'Total', value: queue.total },
    ].map(c => '<div class="card"><div class="label">' + c.label + '</div><div class="value">' + c.value + '</div></div>').join('');

    const qBody = document.querySelector('#queue-table tbody');
    qBody.innerHTML = queue.tasks.slice(0, 20).map(t =>
      '<tr><td>' + t.id.slice(0,8) + '</td><td>' + t.agentName + '</td><td>' +
      statusBadge(t.status) +
      '</td><td>' + t.priority + '</td><td>' + (t.source || '-') + '</td><td>' + fmtTime(t.createdAt) + '</td></tr>'
    ).join('') || '<tr><td colspan="6" style="color:#8b949e">Queue empty</td></tr>';

    const aBody = document.querySelector('#agent-table tbody');
    const sorted = [...agents].sort((a,b) => (b.totalCostToday || 0) - (a.totalCostToday || 0));
    aBody.innerHTML = sorted.map(a =>
      '<tr><td>' + a.name + '</td><td>' +
      (a.enabled ? (a.pauseUntil && new Date(a.pauseUntil) > new Date() ? badge('paused','yellow') : badge('active','green')) : badge('disabled','red')) +
      '</td><td>' + a.schedule + '</td><td>' + (a.runsToday || 0) + '</td><td>' + fmtCost(a.totalCostToday) +
      '</td><td>' + fmtCost(a.dailyCostLimit) + '</td><td>' + (a.failureCount7d || 0) +
      '</td><td>' + fmtDuration(a.avgDurationMs) + '</td><td>' + fmtTime(a.lastRun) + '</td></tr>'
    ).join('');

    document.getElementById('cost-cards').innerHTML = [
      { label: 'Total Today', value: fmtCost(costs.totalCostToday) },
      { label: 'Active Agents', value: Object.keys(costs.agents).length },
    ].map(c => '<div class="card"><div class="label">' + c.label + '</div><div class="value">' + c.value + '</div></div>').join('');

    document.getElementById('lastRefresh').textContent = 'Updated: ' + new Date().toLocaleTimeString();
    document.getElementById('error').textContent = '';
  } catch (e) {
    document.getElementById('error').textContent = 'Refresh error: ' + e.message;
  }
}

refresh();
setInterval(refresh, 30000);`;

  return wrapPage('Bot Dashboard', 'overview', bodyHTML, bodyJS);
}
