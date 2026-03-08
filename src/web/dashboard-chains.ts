/**
 * Task Chain page — Agent-Centric org chart visualization.
 *
 * Layer 1: Agent cards grouped by role with HANDOFF flow arrows
 * Layer 2: Side panel with agent tasks, chain detail, system prompt editor
 */

import { wrapPage } from './dashboard-shared.js';

export function getChainsHTML(): string {
  const extraCSS = `
  .chains-layout { display: flex; gap: 0; height: calc(100vh - 90px); }
  .main-area { flex: 1; overflow-y: auto; padding: 16px; }
  .side-panel { width: 420px; min-width: 380px; border-left: 1px solid #21262d; overflow-y: auto; padding: 16px; display: none; background: #0d1117; }
  .side-panel.open { display: block; }
  .side-panel h2 { margin-top: 0; }

  /* Role groups */
  .role-group { margin-bottom: 20px; }
  .role-header { font-size: 0.85rem; color: #8b949e; margin-bottom: 8px; cursor: pointer; user-select: none; }
  .role-header:hover { color: #c9d1d9; }
  .role-header .arrow { display: inline-block; transition: transform 0.2s; margin-right: 4px; }
  .role-header .arrow.collapsed { transform: rotate(-90deg); }

  /* Agent cards */
  .agent-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(155px, 1fr)); gap: 10px; }
  .agent-card { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 10px; cursor: pointer; transition: border-color 0.15s, opacity 0.15s; position: relative; }
  .agent-card:hover { border-color: #388bfd; }
  .agent-card.selected { border-color: #58a6ff; box-shadow: 0 0 0 1px #58a6ff; }
  .agent-card.idle { opacity: 0.55; }
  .agent-card.idle:hover { opacity: 0.85; }
  .agent-card .agent-name { font-size: 0.85rem; font-weight: 600; color: #c9d1d9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .agent-card .agent-label { font-size: 0.7rem; color: #8b949e; }
  .agent-card .agent-stats { font-size: 0.75rem; color: #8b949e; margin-top: 6px; display: flex; gap: 6px; flex-wrap: wrap; }
  .agent-card .agent-status { margin-top: 4px; }

  /* Side panel sections */
  .sp-section { margin-bottom: 16px; }
  .sp-section h3 { font-size: 0.9rem; color: #c9d1d9; margin-bottom: 6px; }
  .task-item { background: #161b22; border: 1px solid #21262d; border-radius: 6px; padding: 8px 10px; margin-bottom: 6px; cursor: pointer; }
  .task-item:hover { border-color: #30363d; }
  .task-item .task-id { font-family: monospace; font-size: 0.75rem; color: #8b949e; }
  .task-item .task-prompt { font-size: 0.8rem; color: #c9d1d9; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .task-item .task-meta { font-size: 0.7rem; color: #8b949e; margin-top: 4px; }

  /* Chain flow */
  .chain-flow { padding-left: 8px; }
  .chain-node { position: relative; margin-left: 0; padding: 6px 10px; margin-bottom: 0; background: #161b22; border: 1px solid #21262d; border-radius: 6px; font-size: 0.8rem; }
  .chain-node.current { border-color: #d29922; }
  .chain-connector { width: 2px; height: 16px; background: #30363d; margin-left: 20px; }
  .chain-connector-label { font-size: 0.65rem; color: #8b949e; margin-left: 28px; margin-top: -4px; margin-bottom: -2px; }
  .chain-node .cn-agent { font-weight: 600; }
  .chain-node .cn-meta { color: #8b949e; font-size: 0.7rem; }

  /* System prompt editor */
  .prompt-editor { width: 100%; min-height: 200px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; font-family: monospace; font-size: 0.8rem; padding: 8px; resize: vertical; }
  .prompt-actions { margin-top: 6px; display: flex; gap: 8px; align-items: center; }
  .prompt-status { font-size: 0.75rem; color: #8b949e; }

  /* Config summary */
  .config-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; font-size: 0.75rem; }
  .config-grid .cfg-label { color: #8b949e; }
  .config-grid .cfg-value { color: #c9d1d9; }

  /* Collapsible */
  .collapsible-toggle { cursor: pointer; user-select: none; color: #58a6ff; font-size: 0.8rem; }
  .collapsible-toggle:hover { text-decoration: underline; }
  .collapsible-body { display: none; margin-top: 8px; }
  .collapsible-body.open { display: block; }

  /* Personality editor */
  .personality-section-desc { font-size: 0.75rem; color: #8b949e; margin-bottom: 10px; line-height: 1.4; }
  .personality-field { display: flex; align-items: center; gap: 8px; margin-bottom: 2px; font-size: 0.8rem; }
  .personality-field label { color: #8b949e; min-width: 80px; }
  .personality-field input[type="text"] { flex: 1; background: #0d1117; border: 1px solid #30363d; border-radius: 4px; color: #c9d1d9; padding: 4px 8px; font-size: 0.8rem; }
  .personality-field input[type="range"] { flex: 1; accent-color: #58a6ff; }
  .personality-field .range-val { color: #c9d1d9; min-width: 28px; text-align: right; font-family: monospace; font-size: 0.75rem; }
  .field-hint { font-size: 0.7rem; color: #6e7681; margin: 0 0 8px 88px; }

  .report-link { color: #58a6ff; text-decoration: none; font-size: 0.75rem; }
  .report-link:hover { text-decoration: underline; }
  .close-btn { position: absolute; top: 8px; right: 12px; cursor: pointer; color: #8b949e; font-size: 1.2rem; background: none; border: none; }
  .close-btn:hover { color: #c9d1d9; }
  `;

  const bodyHTML = `
<style>${extraCSS}</style>
<div class="chains-layout">
  <div class="main-area" id="main-area">
    <h1>Agent Org Chart <span class="refresh" id="lastRefresh"></span></h1>
    <div id="error"></div>
    <div id="agent-groups"></div>
  </div>
  <div class="side-panel" id="side-panel">
    <button class="close-btn" onclick="closePanel()">&times;</button>
    <div id="sp-content"></div>
  </div>
</div>`;

  const bodyJS = `
let workloadData = [];
let flowData = [];
let selectedAgent = null;

const ROLE_ORDER = ['code','content','research','observer','general'];
const ROLE_LABELS = {
  code: 'Code Pipeline',
  content: 'Content Pipeline',
  research: 'Research & Analysis',
  observer: 'Observers',
  general: 'Operations',
};

function groupByRole(agents) {
  const groups = {};
  for (const a of agents) {
    const role = a.role || 'general';
    const group = ROLE_ORDER.includes(role) ? role : 'general';
    if (!groups[group]) groups[group] = [];
    groups[group].push(a);
  }
  return groups;
}

function getAgentStatus(a) {
  if (a.running > 0) return { text: a.running + ' running', type: 'yellow', idle: false };
  if (a.pending > 0) return { text: a.pending + ' pending', type: 'gray', idle: false };
  return { text: 'idle', type: 'gray', idle: true };
}

function renderAgentGroups() {
  const groups = groupByRole(workloadData);
  let html = '';
  for (const role of ROLE_ORDER) {
    const agents = groups[role];
    if (!agents || agents.length === 0) continue;
    const label = ROLE_LABELS[role] || role;
    html += '<div class="role-group">';
    html += '<div class="role-header" onclick="toggleGroup(this)"><span class="arrow">▼</span> ' + label + '</div>';
    html += '<div class="agent-grid">';
    for (const a of agents) {
      const st = getAgentStatus(a);
      const isSelected = selectedAgent === a.name;
      html += '<div class="agent-card' + (st.idle ? ' idle' : '') + (isSelected ? ' selected' : '') + '" onclick="selectAgent(\\''+a.name+'\\')"><div class="agent-name">' + a.name + '</div><div class="agent-label">' + escHtml(a.label) + '</div><div class="agent-status">' + badge(st.text, st.type) + (a.running > 0 ? ' <span class="pulse">●</span>' : '') + '</div><div class="agent-stats"><span>' + a.completedToday + ' done</span><span>' + fmtCost(a.costToday) + '</span></div></div>';
    }
    html += '</div></div>';
  }
  document.getElementById('agent-groups').innerHTML = html;
}

function toggleGroup(el) {
  const grid = el.nextElementSibling;
  const arrow = el.querySelector('.arrow');
  if (grid.style.display === 'none') { grid.style.display = ''; arrow.classList.remove('collapsed'); }
  else { grid.style.display = 'none'; arrow.classList.add('collapsed'); }
}

function closePanel() {
  document.getElementById('side-panel').classList.remove('open');
  selectedAgent = null;
  renderAgentGroups();
}

async function selectAgent(name) {
  selectedAgent = name;
  renderAgentGroups();
  const panel = document.getElementById('side-panel');
  panel.classList.add('open');
  document.getElementById('sp-content').innerHTML = '<p style="color:#8b949e">Loading...</p>';

  try {
    const [tasks, config] = await Promise.all([
      fetchJson('/api/agents/' + encodeURIComponent(name) + '/tasks?limit=20'),
      fetchJson('/api/agents/' + encodeURIComponent(name) + '/config'),
    ]);
    renderSidePanel(name, tasks, config);
  } catch(e) {
    document.getElementById('sp-content').innerHTML = '<p style="color:#f85149">Error: ' + e.message + '</p>';
  }
}

function renderSidePanel(name, tasks, config) {
  const agent = workloadData.find(a => a.name === name) || {};
  let html = '<h2>' + escHtml(config?.name || name) + '</h2>';
  html += '<div style="color:#8b949e;font-size:0.8rem;margin-bottom:12px">' + escHtml(agent.label || '') + '</div>';

  // Stats
  html += '<div class="sp-section"><div class="agent-stats" style="font-size:0.8rem">';
  html += '<span>' + (agent.completedToday||0) + ' done today</span>';
  html += '<span>' + fmtCost(agent.costToday||0) + '</span>';
  html += '<span>avg ' + fmtDuration(agent.avgDurationMs||0) + '</span>';
  html += '</div></div>';

  // Task sections (wrapped for partial refresh)
  html += '<div id="sp-tasks">';
  const running = tasks.filter(t => t.status === 'running');
  if (running.length > 0) {
    html += '<div class="sp-section"><h3>Running (' + running.length + ')</h3>';
    for (const t of running) {
      html += renderTaskItem(t, name);
    }
    html += '</div>';
  }

  const pending = tasks.filter(t => t.status === 'pending');
  if (pending.length > 0) {
    html += '<div class="sp-section"><h3>Pending (' + pending.length + ')</h3>';
    for (const t of pending) {
      html += renderTaskItem(t, name);
    }
    html += '</div>';
  }

  const completed = tasks.filter(t => t.status === 'completed' || t.status === 'failed');
  if (completed.length > 0) {
    html += '<div class="sp-section"><h3>Recent Completed</h3>';
    for (const t of completed) {
      html += renderTaskItem(t, name);
    }
    html += '</div>';
  }
  html += '</div>';

  // Config summary
  if (config) {
    html += '<div class="sp-section">';
    html += '<span class="collapsible-toggle" onclick="toggleCollapsible(this)">▶ Agent Config</span>';
    html += '<div class="collapsible-body"><div class="config-grid">';
    html += '<span class="cfg-label">Model</span><span class="cfg-value">' + (config.model || 'default') + '</span>';
    html += '<span class="cfg-label">Max Turns</span><span class="cfg-value">' + config.maxTurns + '</span>';
    html += '<span class="cfg-label">Timeout</span><span class="cfg-value">' + fmtDuration(config.timeout) + '</span>';
    html += '<span class="cfg-label">Schedule</span><span class="cfg-value">' + escHtml(config.schedule) + '</span>';
    html += '<span class="cfg-label">Cost Limit</span><span class="cfg-value">' + fmtCost(config.dailyCostLimit) + '</span>';
    html += '<span class="cfg-label">Prompt Locked</span><span class="cfg-value">' + (config.promptLocked ? 'Yes' : 'No') + '</span>';
    html += '</div></div></div>';
  }

  // Personality editor
  if (config) {
    const p = config.personality || {};
    html += '<div class="sp-section">';
    html += '<span class="collapsible-toggle" onclick="toggleCollapsible(this)">▶ Personality</span>';
    html += '<div class="collapsible-body">';
    html += '<div class="personality-section-desc">個性與職責（System Prompt）分離管理。個性影響語氣和風格，職責定義任務範圍。</div>';
    html += '<div class="personality-field"><label>Tagline</label><input type="text" id="p-tagline" value="' + escHtml(p.tagline || '') + '" maxlength="100" placeholder="例：嚴謹的工匠，追求零缺陷"></div>';
    html += '<div class="field-hint">一句話人設，定義角色定位（≤100 字）</div>';
    html += '<div class="personality-field"><label>Tone</label><input type="text" id="p-tone" value="' + escHtml(p.tone || '') + '" maxlength="50" placeholder="例：直接犀利"></div>';
    html += '<div class="field-hint">溝通語氣風格（≤50 字）</div>';
    html += '<div class="personality-field"><label>Opinionated</label><input type="range" id="p-opinionated" min="0" max="1" step="0.1" value="' + (p.opinionated ?? 0.5) + '" oninput="this.nextElementSibling.textContent=this.value"><span class="range-val">' + (p.opinionated ?? 0.5) + '</span></div>';
    html += '<div class="field-hint">主動表達意見程度：0=只執行不評論 → 1=積極建議</div>';
    html += '<div class="personality-field"><label>Verbosity</label><input type="range" id="p-verbosity" min="0" max="1" step="0.1" value="' + (p.verbosity ?? 0.5) + '" oninput="this.nextElementSibling.textContent=this.value"><span class="range-val">' + (p.verbosity ?? 0.5) + '</span></div>';
    html += '<div class="field-hint">輸出詳盡度：0=極簡扼要 → 1=詳盡完整</div>';
    html += '<div class="prompt-actions">';
    html += '<button class="btn btn-primary" onclick="savePersonality(\\''+name+'\\')">Save Personality</button>';
    html += '<span class="prompt-status" id="personality-status"></span>';
    html += '</div></div></div>';
  }

  // System Prompt editor
  if (config) {
    html += '<div class="sp-section">';
    html += '<span class="collapsible-toggle" onclick="toggleCollapsible(this)">▶ System Prompt</span>';
    html += '<div class="collapsible-body">';
    html += '<div class="personality-section-desc">定義 agent 的任務職責、工作範圍和行為規則。與個性（Personality）分開管理。</div>';
    html += '<textarea class="prompt-editor" id="prompt-editor">' + escHtml(config.systemPrompt || '') + '</textarea>';
    html += '<div class="prompt-actions">';
    html += '<button class="btn btn-primary" onclick="savePrompt(\\''+name+'\\')">Save</button>';
    html += '<span class="prompt-status" id="prompt-status"></span>';
    html += '</div></div></div>';
  }

  // Links
  html += '<div class="sp-section" style="margin-top:12px">';
  html += '<a class="report-link" href="/reports#agent=' + encodeURIComponent(name) + '">View All Reports →</a>';
  html += '</div>';

  document.getElementById('sp-content').innerHTML = html;
}

function renderTaskItem(t, currentAgent) {
  let html = '<div class="task-item" onclick="toggleChain(this, \\''+t.id+'\\')">';
  html += '<div style="display:flex;justify-content:space-between;align-items:center">';
  html += '<span class="task-id">#' + t.id.slice(0,8) + '</span>';
  html += statusBadge(t.status);
  html += '</div>';
  html += '<div class="task-prompt">' + escHtml(t.prompt.slice(0,120)) + '</div>';
  html += '<div class="task-meta">';
  if (t.source === 'handoff' && t.handoffIntent) html += t.handoffIntent + ' from upstream · ';
  if (t.status === 'running' && t.startedAt) html += fmtElapsed(t.startedAt) + ' elapsed · ';
  if (t.status === 'completed') html += fmtDuration(t.duration) + ' · ' + fmtCost(t.costUsd) + ' · ';
  if (t.status === 'failed' && t.error) html += escHtml(t.error.slice(0,60)) + ' · ';
  if (t.reportId) html += '<a class="report-link" href="/reports#id=' + t.reportId + '" onclick="event.stopPropagation()">📄 Report</a>';
  html += '</div>';
  html += '<div class="chain-container" id="chain-' + t.id + '" style="display:none"></div>';
  html += '</div>';
  return html;
}

async function toggleChain(el, taskId) {
  const container = document.getElementById('chain-' + taskId);
  if (container.style.display !== 'none') { container.style.display = 'none'; return; }
  container.style.display = 'block';
  container.innerHTML = '<div style="color:#8b949e;font-size:0.75rem;padding:8px">Loading chain...</div>';
  try {
    const nodes = await fetchJson('/api/chains/' + taskId);
    if (!nodes || nodes.length === 0) { container.innerHTML = '<div style="color:#8b949e;font-size:0.75rem;padding:8px">No chain data</div>'; return; }
    let html = '<div class="chain-flow" style="margin-top:8px">';
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const isCurrent = n.id === taskId;
      if (i > 0) {
        const intent = n.handoffIntent || n.source || '';
        html += '<div class="chain-connector"></div>';
        if (intent) html += '<div class="chain-connector-label">' + intent + '</div>';
      }
      html += '<div class="chain-node' + (isCurrent ? ' current' : '') + '">';
      html += '<span class="cn-agent">' + n.agentName + '</span> ';
      html += statusBadge(n.status);
      html += '<div class="cn-meta">';
      if (n.completedAt) html += fmtDuration(n.duration) + ' · ';
      if (n.costUsd) html += fmtCost(n.costUsd) + ' · ';
      if (n.status === 'running' && n.startedAt) html += fmtElapsed(n.startedAt) + ' elapsed · ';
      if (n.reportId) html += '<a class="report-link" href="/reports#id='+n.reportId+'" onclick="event.stopPropagation()">📄</a>';
      html += '</div></div>';
    }
    html += '</div>';
    container.innerHTML = html;
  } catch(e) {
    container.innerHTML = '<div style="color:#f85149;font-size:0.75rem;padding:8px">Error: '+e.message+'</div>';
  }
}

function toggleCollapsible(el) {
  const body = el.nextElementSibling;
  const isOpen = body.classList.contains('open');
  body.classList.toggle('open');
  el.textContent = (isOpen ? '▶ ' : '▼ ') + el.textContent.slice(2);
}

async function savePrompt(agentName) {
  const editor = document.getElementById('prompt-editor');
  const status = document.getElementById('prompt-status');
  status.textContent = 'Saving...';
  status.style.color = '#d29922';
  try {
    const res = await fetch(BASE + '/api/agents/' + encodeURIComponent(agentName) + '/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemPrompt: editor.value }),
    });
    const data = await res.json();
    if (data.ok) { status.textContent = 'Saved!'; status.style.color = '#3fb950'; }
    else { status.textContent = 'Error: ' + (data.error || 'unknown'); status.style.color = '#f85149'; }
  } catch(e) { status.textContent = 'Error: ' + e.message; status.style.color = '#f85149'; }
  setTimeout(() => { status.textContent = ''; }, 3000);
}

async function savePersonality(agentName) {
  const status = document.getElementById('personality-status');
  status.textContent = 'Saving...';
  status.style.color = '#d29922';
  try {
    const personality = {
      tagline: document.getElementById('p-tagline').value,
      tone: document.getElementById('p-tone').value,
      opinionated: parseFloat(document.getElementById('p-opinionated').value),
      verbosity: parseFloat(document.getElementById('p-verbosity').value),
    };
    const res = await fetch(BASE + '/api/agents/' + encodeURIComponent(agentName) + '/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personality }),
    });
    const data = await res.json();
    if (data.ok) { status.textContent = 'Saved!'; status.style.color = '#3fb950'; }
    else { status.textContent = 'Error: ' + (data.error || 'unknown'); status.style.color = '#f85149'; }
  } catch(e) { status.textContent = 'Error: ' + e.message; status.style.color = '#f85149'; }
  setTimeout(() => { status.textContent = ''; }, 3000);
}

async function refreshWorkload() {
  try {
    const [wl, fm] = await Promise.all([
      fetchJson('/api/agents/workload'),
      fetchJson('/api/agents/flowmap'),
    ]);
    workloadData = wl;
    flowData = fm;
    renderAgentGroups();
    document.getElementById('lastRefresh').textContent = 'Updated: ' + new Date().toLocaleTimeString();
    document.getElementById('error').textContent = '';

    // Side panel: only refresh task list, never re-render full panel (preserves collapsible state + edits)
    if (selectedAgent) {
      const tasks = await fetchJson('/api/agents/' + encodeURIComponent(selectedAgent) + '/tasks?limit=20');
      const taskContainer = document.getElementById('sp-tasks');
      if (taskContainer) {
        let taskHtml = '';
        const running = tasks.filter(t => t.status === 'running');
        const pending = tasks.filter(t => t.status === 'pending');
        const done = tasks.filter(t => t.status === 'completed' || t.status === 'failed');
        if (running.length > 0) {
          taskHtml += '<div class="sp-section"><h3>Running (' + running.length + ')</h3>';
          for (const t of running) taskHtml += renderTaskItem(t, selectedAgent);
          taskHtml += '</div>';
        }
        if (pending.length > 0) {
          taskHtml += '<div class="sp-section"><h3>Pending (' + pending.length + ')</h3>';
          for (const t of pending) taskHtml += renderTaskItem(t, selectedAgent);
          taskHtml += '</div>';
        }
        if (done.length > 0) {
          taskHtml += '<div class="sp-section"><h3>Recent Completed</h3>';
          for (const t of done) taskHtml += renderTaskItem(t, selectedAgent);
          taskHtml += '</div>';
        }
        taskContainer.innerHTML = taskHtml || '<div style="color:#8b949e;font-size:0.8rem">No recent tasks</div>';
      }
    }
  } catch(e) {
    document.getElementById('error').textContent = 'Error: ' + e.message;
  }
}

refreshWorkload();
setInterval(refreshWorkload, 10000);
`;

  return wrapPage('Task Chains — Agent Org Chart', 'chains', bodyHTML, bodyJS);
}
