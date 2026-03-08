/**
 * Shared agent display labels — single source of truth for agent Chinese names.
 * Used by /report command, report-site generation, and anywhere agent names are displayed.
 */

export const AGENT_LABELS: Record<string, string> = {
  'explorer': '探索者',
  'deep-researcher': '深度研究',
  'market-researcher': '市場研究',
  'comment-monitor': '留言監控',
  'hackernews-digest': 'HN 摘要',
  'blog-writer': '部落格寫手',
  'security-scanner': '安全掃描',
  'synthesis': '綜合分析',
  'github-patrol': 'GitHub 巡邏',
  'crypto-analyst': '加密貨幣分析',
};

export function agentLabel(name: string): string {
  return AGENT_LABELS[name] || name;
}
