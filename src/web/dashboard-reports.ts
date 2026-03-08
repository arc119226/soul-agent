/**
 * Report Viewer page — two-pane layout with markdown rendering.
 *
 * Left pane: paginated report list with agent/date/search filters
 * Right pane: full report content rendered as markdown via marked.js CDN
 */

import { wrapPage } from './dashboard-shared.js';

export function getReportsHTML(): string {
  const extraCSS = `
  .reports-layout { display: flex; gap: 0; height: calc(100vh - 90px); }
  .report-list-pane { width: 340px; min-width: 300px; border-right: 1px solid #21262d; overflow-y: auto; display: flex; flex-direction: column; }
  .report-content-pane { flex: 1; overflow-y: auto; padding: 16px 24px; }

  /* Filters */
  .report-filters { padding: 12px; border-bottom: 1px solid #21262d; display: flex; flex-wrap: wrap; gap: 6px; }
  .report-filters select, .report-filters input {
    background: #0d1117; border: 1px solid #30363d; color: #c9d1d9; padding: 4px 8px; border-radius: 4px; font-size: 0.8rem;
  }
  .report-filters input[type="text"] { flex: 1; min-width: 100px; }

  /* Report items */
  .report-items { flex: 1; overflow-y: auto; }
  .report-item { padding: 10px 12px; border-bottom: 1px solid #21262d; cursor: pointer; transition: background 0.1s; }
  .report-item:hover { background: #161b22; }
  .report-item.selected { background: #161b22; border-left: 3px solid #58a6ff; }
  .report-item .ri-agent { font-size: 0.8rem; font-weight: 600; }
  .report-item .ri-time { font-size: 0.7rem; color: #8b949e; }
  .report-item .ri-snippet { font-size: 0.75rem; color: #8b949e; margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .report-item .ri-meta { font-size: 0.7rem; color: #8b949e; margin-top: 2px; }

  /* Pagination */
  .report-pagination { padding: 8px 12px; border-top: 1px solid #21262d; display: flex; justify-content: space-between; align-items: center; font-size: 0.75rem; color: #8b949e; }
  .report-pagination button { background: #21262d; border: 1px solid #30363d; color: #c9d1d9; padding: 3px 10px; border-radius: 4px; cursor: pointer; font-size: 0.75rem; }
  .report-pagination button:disabled { opacity: 0.4; cursor: default; }

  /* Markdown body */
  .report-header { margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid #21262d; }
  .report-header h2 { color: #c9d1d9; border: none; margin: 0 0 8px; font-size: 1.1rem; }
  .report-header .rh-meta { font-size: 0.8rem; color: #8b949e; }
  .report-header .rh-meta span { margin-right: 16px; }

  .markdown-body { line-height: 1.7; font-size: 0.9rem; }
  .markdown-body h1 { font-size: 1.4rem; color: #c9d1d9; border-bottom: 1px solid #21262d; padding-bottom: 6px; margin: 20px 0 10px; }
  .markdown-body h2 { font-size: 1.2rem; color: #c9d1d9; border-bottom: 1px solid #21262d; padding-bottom: 4px; margin: 18px 0 8px; }
  .markdown-body h3 { font-size: 1.05rem; color: #c9d1d9; margin: 14px 0 6px; }
  .markdown-body p { margin: 8px 0; }
  .markdown-body ul, .markdown-body ol { padding-left: 24px; margin: 8px 0; }
  .markdown-body li { margin: 4px 0; }
  .markdown-body code { background: #161b22; padding: 2px 6px; border-radius: 3px; font-size: 0.85em; font-family: monospace; }
  .markdown-body pre { background: #161b22; padding: 12px; border-radius: 6px; overflow-x: auto; margin: 8px 0; }
  .markdown-body pre code { background: none; padding: 0; }
  .markdown-body table { border-collapse: collapse; width: 100%; margin: 8px 0; }
  .markdown-body td, .markdown-body th { border: 1px solid #30363d; padding: 6px 12px; font-size: 0.85rem; }
  .markdown-body th { background: #161b22; }
  .markdown-body blockquote { border-left: 3px solid #30363d; padding-left: 12px; color: #8b949e; margin: 8px 0; }
  .markdown-body a { color: #58a6ff; text-decoration: none; }
  .markdown-body a:hover { text-decoration: underline; }
  .markdown-body hr { border: none; border-top: 1px solid #21262d; margin: 16px 0; }
  .markdown-body strong { color: #c9d1d9; }

  .placeholder { color: #8b949e; text-align: center; margin-top: 40%; font-size: 0.9rem; }
  `;

  const bodyHTML = `
<style>${extraCSS}</style>
<div class="reports-layout">
  <div class="report-list-pane">
    <div class="report-filters">
      <select id="filter-agent"><option value="">All Agents</option></select>
      <input type="date" id="filter-from" title="From date">
      <input type="date" id="filter-to" title="To date">
      <input type="text" id="filter-search" placeholder="Search...">
    </div>
    <div class="report-items" id="report-items"></div>
    <div class="report-pagination">
      <button id="btn-prev" onclick="prevPage()" disabled>← Prev</button>
      <span id="page-info">Page 1</span>
      <button id="btn-next" onclick="nextPage()">Next →</button>
    </div>
  </div>
  <div class="report-content-pane" id="report-content">
    <div class="placeholder">Select a report to view</div>
  </div>
</div>`;

  const bodyJS = `
// Load marked.js from CDN
(function() {
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/marked@15/marked.min.js';
  s.onload = function() { window.markedReady = true; };
  document.head.appendChild(s);
})();

function renderMarkdown(md) {
  if (window.marked) return window.marked.parse(md);
  return '<pre style="white-space:pre-wrap">' + escHtml(md) + '</pre>';
}

let currentPage = 1;
let totalPages = 1;
let selectedReportId = null;
let agentList = [];

async function loadAgentList() {
  try {
    const agents = await fetchJson('/api/agents');
    agentList = agents.map(a => a.name).sort();
    const select = document.getElementById('filter-agent');
    for (const name of agentList) {
      const opt = document.createElement('option');
      opt.value = name; opt.textContent = name;
      select.appendChild(opt);
    }
  } catch(e) { /* non-fatal */ }
}

function buildQuery() {
  const agent = document.getElementById('filter-agent').value;
  const from = document.getElementById('filter-from').value;
  const to = document.getElementById('filter-to').value;
  const search = document.getElementById('filter-search').value.trim();
  let path = '';

  if (search) {
    path = '/api/reports/search?q=' + encodeURIComponent(search) + '&limit=20';
    return { path, isSearch: true };
  }

  const params = new URLSearchParams();
  params.set('page', currentPage.toString());
  params.set('limit', '20');
  if (agent) params.set('agent', agent);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  path = '/api/reports?' + params.toString();
  return { path, isSearch: false };
}

async function loadReports() {
  const { path, isSearch } = buildQuery();
  try {
    const data = await fetchJson(path);
    const items = document.getElementById('report-items');

    if (isSearch) {
      // Search returns flat array
      const reports = Array.isArray(data) ? data : [];
      items.innerHTML = reports.length === 0
        ? '<div style="padding:20px;color:#8b949e;text-align:center">No results</div>'
        : reports.map(r => renderReportItem(r)).join('');
      document.getElementById('page-info').textContent = reports.length + ' results';
      document.getElementById('btn-prev').disabled = true;
      document.getElementById('btn-next').disabled = true;
    } else {
      totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
      const reports = data.reports || [];
      items.innerHTML = reports.length === 0
        ? '<div style="padding:20px;color:#8b949e;text-align:center">No reports</div>'
        : reports.map(r => renderReportItem(r)).join('');
      document.getElementById('page-info').textContent = 'Page ' + currentPage + ' / ' + totalPages + ' (' + data.total + ')';
      document.getElementById('btn-prev').disabled = currentPage <= 1;
      document.getElementById('btn-next').disabled = currentPage >= totalPages;
    }
  } catch(e) {
    document.getElementById('report-items').innerHTML = '<div style="padding:20px;color:#f85149">Error: ' + e.message + '</div>';
  }
}

function renderReportItem(r) {
  const isSelected = selectedReportId === r.id;
  return '<div class="report-item' + (isSelected ? ' selected' : '') + '" onclick="viewReport('+r.id+')">'
    + '<div style="display:flex;justify-content:space-between"><span class="ri-agent">' + escHtml(r.agentName) + '</span><span class="ri-time">' + fmtTimeShort(r.timestamp) + '</span></div>'
    + '<div class="ri-snippet">' + escHtml(r.resultSnippet || r.promptSnippet || '') + '</div>'
    + '<div class="ri-meta">' + fmtCost(r.costUsd) + ' · ' + Math.round((r.confidence||0)*100) + '% conf</div>'
    + '</div>';
}

async function viewReport(id) {
  selectedReportId = id;
  loadReports(); // refresh selection highlight
  const content = document.getElementById('report-content');
  content.innerHTML = '<div class="placeholder">Loading...</div>';
  try {
    const r = await fetchJson('/api/reports/' + id);
    if (!r) { content.innerHTML = '<div class="placeholder">Report not found</div>'; return; }
    let html = '<div class="report-header">';
    html += '<h2>' + escHtml(r.agentName) + ' Report</h2>';
    html += '<div class="rh-meta">';
    html += '<span>📅 ' + fmtTime(r.timestamp) + '</span>';
    html += '<span>💰 ' + fmtCost(r.costUsd) + '</span>';
    html += '<span>⏱ ' + fmtDuration(r.duration) + '</span>';
    html += '<span>🎯 ' + Math.round((r.confidence||0)*100) + '%</span>';
    if (r.taskId) html += '<span>🔗 ' + r.taskId.slice(0,8) + '</span>';
    html += '</div></div>';
    html += '<div class="markdown-body">' + renderMarkdown(r.result || '') + '</div>';
    content.innerHTML = html;
  } catch(e) {
    content.innerHTML = '<div class="placeholder" style="color:#f85149">Error: ' + e.message + '</div>';
  }
}

function prevPage() { if (currentPage > 1) { currentPage--; loadReports(); } }
function nextPage() { if (currentPage < totalPages) { currentPage++; loadReports(); } }

// Filter change handlers
document.getElementById('filter-agent').onchange = function() { currentPage = 1; loadReports(); };
document.getElementById('filter-from').onchange = function() { currentPage = 1; loadReports(); };
document.getElementById('filter-to').onchange = function() { currentPage = 1; loadReports(); };
let searchTimeout = null;
document.getElementById('filter-search').oninput = function() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(function() { currentPage = 1; loadReports(); }, 300);
};

// Handle URL hash for deep linking: /reports#id=123 or /reports#agent=programmer
function handleHash() {
  const hash = location.hash.slice(1);
  if (!hash) return;
  const params = new URLSearchParams(hash);
  if (params.has('id')) {
    viewReport(parseInt(params.get('id'), 10));
  }
  if (params.has('agent')) {
    document.getElementById('filter-agent').value = params.get('agent');
    loadReports();
  }
}

loadAgentList();
loadReports();
handleHash();
window.addEventListener('hashchange', handleHash);
`;

  return wrapPage('Reports — Markdown Viewer', 'reports', bodyHTML, bodyJS);
}
