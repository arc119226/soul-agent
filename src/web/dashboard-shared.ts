/**
 * Shared CSS, JS utilities, and navigation bar for all dashboard pages.
 */

export function getNavHTML(active: 'overview' | 'chains' | 'reports'): string {
  const items = [
    { key: 'overview', label: 'Overview', href: '/' },
    { key: 'chains', label: 'Task Chains', href: '/chains' },
    { key: 'reports', label: 'Reports', href: '/reports' },
  ];
  return `<nav class="nav-bar">${items.map(i =>
    `<a href="${i.href}" class="nav-link${i.key === active ? ' active' : ''}">${i.label}</a>`,
  ).join('')}</nav>`;
}

export function getSharedCSS(): string {
  return `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; background: #0d1117; color: #c9d1d9; padding: 0; }
  .nav-bar { display: flex; gap: 0; background: #161b22; border-bottom: 1px solid #21262d; padding: 0 16px; }
  .nav-link { color: #8b949e; text-decoration: none; padding: 10px 16px; font-size: 0.9rem; border-bottom: 2px solid transparent; transition: color 0.15s, border-color 0.15s; }
  .nav-link:hover { color: #c9d1d9; }
  .nav-link.active { color: #58a6ff; border-bottom-color: #58a6ff; }
  .page { padding: 16px; }
  h1 { font-size: 1.4rem; margin-bottom: 12px; color: #58a6ff; }
  h2 { font-size: 1.1rem; margin: 16px 0 8px; color: #8b949e; border-bottom: 1px solid #21262d; padding-bottom: 4px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; margin-bottom: 16px; }
  .card { background: #161b22; border: 1px solid #21262d; border-radius: 6px; padding: 12px; }
  .card .label { font-size: 0.75rem; color: #8b949e; text-transform: uppercase; }
  .card .value { font-size: 1.5rem; font-weight: 600; margin-top: 4px; }
  .ok { color: #3fb950; } .degraded { color: #d29922; } .unhealthy { color: #f85149; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #21262d; font-size: 0.85rem; }
  th { color: #8b949e; font-weight: 500; }
  tr:hover { background: #161b22; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: 500; }
  .badge-green { background: #1b4332; color: #3fb950; }
  .badge-red { background: #3d1a1a; color: #f85149; }
  .badge-yellow { background: #3d2e00; color: #d29922; }
  .badge-gray { background: #21262d; color: #8b949e; }
  .badge-blue { background: #0c2d6b; color: #58a6ff; }
  .refresh { color: #8b949e; font-size: 0.75rem; margin-left: 8px; }
  #error { color: #f85149; font-size: 0.85rem; margin: 8px 0; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
  .pulse { animation: pulse 1.5s ease-in-out infinite; }
  .btn { background: #21262d; border: 1px solid #30363d; color: #c9d1d9; padding: 4px 12px; border-radius: 6px; cursor: pointer; font-size: 0.8rem; }
  .btn:hover { background: #30363d; }
  .btn-primary { background: #1f6feb; border-color: #388bfd; color: #fff; }
  .btn-primary:hover { background: #388bfd; }
  `;
}

export function getSharedJS(): string {
  return `
  const BASE = location.origin;
  async function fetchJson(path) {
    const res = await fetch(BASE + path);
    if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
    return res.json();
  }
  function badge(text, type) {
    return '<span class="badge badge-' + type + '">' + text + '</span>';
  }
  function fmtDuration(ms) {
    if (!ms) return '-';
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    return (ms / 60000).toFixed(1) + 'm';
  }
  function fmtTime(iso) {
    if (!iso) return '-';
    return new Date(iso).toLocaleString();
  }
  function fmtTimeShort(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    return (d.getMonth()+1) + '/' + d.getDate() + ' ' + d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
  }
  function fmtCost(usd) {
    if (!usd) return '$0';
    return '$' + usd.toFixed(4);
  }
  function fmtElapsed(iso) {
    if (!iso) return '';
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60000) return Math.round(ms/1000) + 's';
    return Math.round(ms/60000) + 'm';
  }
  function escHtml(s) {
    return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function statusBadge(status) {
    const map = { running: 'yellow', completed: 'green', failed: 'red', pending: 'gray' };
    return badge(status, map[status] || 'gray');
  }
  `;
}

export function wrapPage(title: string, active: 'overview' | 'chains' | 'reports', bodyHTML: string, bodyJS: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${getSharedCSS()}</style>
</head>
<body>
${getNavHTML(active)}
<div class="page">
${bodyHTML}
</div>
<script>
${getSharedJS()}
${bodyJS}
</script>
</body>
</html>`;
}
