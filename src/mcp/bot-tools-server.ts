#!/usr/bin/env node
/**
 * MCP Server — Bot Tools
 *
 * Provides custom tools for Claude Code via MCP (stdio transport).
 * Spawned automatically by Claude Code when it reads .mcp.json.
 *
 * Tools: web_search, web_fetch, telegram_send, soul_read, soul_write
 */

// MCP stdio uses stdout for protocol messages — redirect console.log to stderr
console.log = (...args: unknown[]) => console.error(...args);

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile, writeFile, rename, mkdir, unlink, readdir } from 'node:fs/promises';
import { request } from 'node:https';
import { join, resolve, normalize, relative, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { searchWeb } from '../web/search.js';
import { fetchUrl } from '../web/fetcher.js';
import { getDb } from '../core/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..', '..'); // src/mcp/ → src/ → project root
const SOUL_DIR = resolve(PROJECT_ROOT, 'soul');
const BOT_TOKEN = process.env.BOT_TOKEN ?? '';

const server = new McpServer({ name: 'bot-tools', version: '1.0.0' });

// ── web_search ──────────────────────────────────────────────

server.tool(
  'web_search',
  'Search the web via DuckDuckGo',
  { query: z.string().describe('Search query') },
  async ({ query }) => {
    const result = await searchWeb(query);
    if (!result.ok) {
      return { content: [{ type: 'text' as const, text: `Search failed: ${result.error}` }], isError: true };
    }
    const text = result.value
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      .join('\n\n');
    return { content: [{ type: 'text' as const, text: text || 'No results found' }] };
  },
);

// ── web_fetch ───────────────────────────────────────────────

server.tool(
  'web_fetch',
  'Fetch a URL and convert HTML to markdown',
  { url: z.string().describe('URL to fetch') },
  async ({ url }) => {
    const result = await fetchUrl(url);
    if (!result.ok) {
      return { content: [{ type: 'text' as const, text: `Fetch failed: ${result.error}` }], isError: true };
    }
    const { title, content, statusCode, contentLength } = result.value;
    const header = title ? `# ${title}\n\n` : '';
    const meta = `[Status: ${statusCode}, Length: ${contentLength}]\n\n`;
    return { content: [{ type: 'text' as const, text: header + meta + content }] };
  },
);

// ── telegram_send ───────────────────────────────────────────

server.tool(
  'telegram_send',
  'Send a message via Telegram Bot API',
  {
    chat_id: z.union([z.number(), z.string()]).describe('Telegram chat ID (number for users/groups, string like "@channel" for channels)'),
    text: z.string().describe('Message text'),
    parse_mode: z.enum(['Markdown', 'MarkdownV2', 'HTML']).optional().describe('Parse mode'),
  },
  async ({ chat_id, text, parse_mode }) => {
    if (!BOT_TOKEN) {
      return { content: [{ type: 'text' as const, text: 'BOT_TOKEN not set' }], isError: true };
    }

    const body: Record<string, unknown> = { chat_id, text };
    if (parse_mode) body.parse_mode = parse_mode;

    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const payload = JSON.stringify(body);

    const data = await new Promise<{ ok: boolean; description?: string }>((resolve, reject) => {
      const req = request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        family: 4, // Force IPv4 — undici's fetch() fails on dual-stack hosts with broken IPv6
      }, (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => { raw += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); }
          catch { reject(new Error(`Invalid JSON: ${raw.slice(0, 200)}`)); }
        });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });

    if (!data.ok) {
      return { content: [{ type: 'text' as const, text: `Telegram error: ${data.description}` }], isError: true };
    }
    return { content: [{ type: 'text' as const, text: `Message sent to chat ${chat_id}` }] };
  },
);

// ── Path safety ─────────────────────────────────────────────

function safeSoulPath(relPath: string): string | null {
  const resolved = resolve(SOUL_DIR, normalize(relPath));
  const rel = relative(SOUL_DIR, resolved);
  // Reject if relative path escapes soul/
  if (rel.startsWith('..') || rel.startsWith(sep) || /^[a-zA-Z]:/.test(rel)) {
    return null;
  }
  return resolved;
}

// ── soul_read ───────────────────────────────────────────────

server.tool(
  'soul_read',
  'Read a file from the soul/ directory',
  { path: z.string().describe('Relative path within soul/ (e.g. "identity.json")') },
  async ({ path }) => {
    const fullPath = safeSoulPath(path);
    if (!fullPath) {
      return { content: [{ type: 'text' as const, text: 'Invalid path: must be within soul/' }], isError: true };
    }
    try {
      const content = await readFile(fullPath, 'utf-8');
      return { content: [{ type: 'text' as const, text: content }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Read failed: ${msg}` }], isError: true };
    }
  },
);

// ── soul_write ──────────────────────────────────────────────

server.tool(
  'soul_write',
  'Write a file to the soul/ directory (atomic write)',
  {
    path: z.string().describe('Relative path within soul/ (e.g. "identity.json")'),
    content: z.string().describe('File content to write'),
  },
  async ({ path, content }) => {
    const fullPath = safeSoulPath(path);
    if (!fullPath) {
      return { content: [{ type: 'text' as const, text: 'Invalid path: must be within soul/' }], isError: true };
    }

    // Protect genesis.md (immutable)
    if (normalize(path) === 'genesis.md') {
      return { content: [{ type: 'text' as const, text: 'Cannot write to genesis.md (immutable)' }], isError: true };
    }

    try {
      const dir = dirname(fullPath);
      await mkdir(dir, { recursive: true });

      // Atomic write: tmp → rename
      const tmpPath = join(dir, `.tmp-${randomUUID()}`);
      await writeFile(tmpPath, content, 'utf-8');
      await rename(tmpPath, fullPath);

      return { content: [{ type: 'text' as const, text: `Written: soul/${path} (${content.length} bytes)` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Write failed: ${msg}` }], isError: true };
    }
  },
);

// ── Skill helpers ──────────────────────────────────────────

const SKILLS_DIR = join(SOUL_DIR, 'skills');
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

/** Validate skill name (lowercase, digits, hyphens, 3-40 chars) */
function isValidSkillName(name: string): boolean {
  return name.length >= 2 && name.length <= 40 && SKILL_NAME_RE.test(name);
}

/** Build a Markdown skill file from structured input */
function buildSkillMarkdown(opts: {
  name: string;
  description: string;
  keywords: string[];
  patterns?: string[];
  priority?: number;
  category?: string;
  version?: string;
  enabled?: boolean;
  requires_modules?: string[];
  requires_agents?: string[];
  triggers_events?: string[];
  triggers_commands?: string[];
  body: string;
}): string {
  const lines: string[] = ['---'];
  lines.push(`name: ${opts.name}`);
  lines.push(`description: ${opts.description}`);

  const writeArray = (key: string, arr: string[] | undefined) => {
    if (!arr || arr.length === 0) return;
    lines.push(`${key}:`);
    for (const item of arr) lines.push(`  - ${item}`);
  };

  writeArray('keywords', opts.keywords);
  writeArray('patterns', opts.patterns);
  lines.push(`priority: ${opts.priority ?? 5}`);
  lines.push(`enabled: ${opts.enabled !== false}`);
  lines.push(`category: ${opts.category ?? 'general'}`);
  lines.push(`version: ${opts.version ?? '1.0'}`);
  writeArray('requires_modules', opts.requires_modules);
  writeArray('requires_agents', opts.requires_agents);
  writeArray('triggers_events', opts.triggers_events);
  writeArray('triggers_commands', opts.triggers_commands);

  lines.push('---');
  lines.push('');
  lines.push(opts.body);

  return lines.join('\n');
}

/** Signal main process to rebuild skill index */
async function signalSkillRebuild(): Promise<void> {
  const signalPath = join(SKILLS_DIR, '.rebuild');
  try {
    await writeFile(signalPath, new Date().toISOString(), 'utf-8');
  } catch {
    // Non-critical — index will rebuild on next matchSkills call
  }
}

/** Atomic write helper */
async function atomicWrite(fullPath: string, content: string): Promise<void> {
  const dir = dirname(fullPath);
  await mkdir(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-${randomUUID()}`);
  await writeFile(tmpPath, content, 'utf-8');
  await rename(tmpPath, fullPath);
}

// ── create_skill ───────────────────────────────────────────

server.tool(
  'create_skill',
  'Create a new Markdown skill in soul/skills/. Skills are knowledge-level extensions that get injected into system prompts when matched.',
  {
    name: z.string().describe('Skill name (lowercase, digits, hyphens, e.g. "daily-hn-digest")'),
    description: z.string().describe('Short description of what this skill does'),
    keywords: z.array(z.string()).describe('Keywords for matching user messages (e.g. ["hacker news", "hn", "tech news"])'),
    body: z.string().describe('Markdown body with instructions for the AI'),
    patterns: z.array(z.string()).optional().describe('Regex patterns for advanced matching'),
    priority: z.number().min(1).max(10).optional().describe('Priority 1-10 (default 5, higher = stronger match)'),
    category: z.string().optional().describe('Category (e.g. "automation", "research", "security")'),
    triggers_commands: z.array(z.string()).optional().describe('Telegram commands that trigger this skill (e.g. ["/hn"])'),
    triggers_events: z.array(z.string()).optional().describe('EventBus events that trigger this skill'),
  },
  async ({ name, description, keywords, body, patterns, priority, category, triggers_commands, triggers_events }) => {
    // Validate name
    if (!isValidSkillName(name)) {
      return { content: [{ type: 'text' as const, text: `Invalid skill name "${name}": must be 2-40 chars, lowercase letters, digits, and hyphens only` }], isError: true };
    }

    // Check for duplicate
    const skillPath = join(SKILLS_DIR, `${name}.md`);
    try {
      await readFile(skillPath, 'utf-8');
      return { content: [{ type: 'text' as const, text: `Skill "${name}" already exists. Use update_skill to modify it.` }], isError: true };
    } catch {
      // File doesn't exist — good
    }

    // Validate keywords
    if (keywords.length === 0) {
      return { content: [{ type: 'text' as const, text: 'At least one keyword is required for skill matching' }], isError: true };
    }

    // Build markdown
    const markdown = buildSkillMarkdown({
      name, description, keywords, body, patterns,
      priority, category, triggers_commands, triggers_events,
    });

    // Atomic write
    try {
      await atomicWrite(skillPath, markdown);
      await signalSkillRebuild();

      return { content: [{ type: 'text' as const, text: `Skill created: soul/skills/${name}.md (${keywords.length} keywords, priority ${priority ?? 5})\n\nSkill index will rebuild on next message match.` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Failed to create skill: ${msg}` }], isError: true };
    }
  },
);

// ── update_skill ───────────────────────────────────────────

server.tool(
  'update_skill',
  'Update an existing Markdown skill. Only provided fields are modified; others are preserved.',
  {
    name: z.string().describe('Name of the skill to update'),
    description: z.string().optional().describe('New description'),
    keywords: z.array(z.string()).optional().describe('New keywords (replaces existing)'),
    body: z.string().optional().describe('New markdown body (replaces existing)'),
    patterns: z.array(z.string()).optional().describe('New regex patterns'),
    priority: z.number().min(1).max(10).optional().describe('New priority'),
    category: z.string().optional().describe('New category'),
    enabled: z.boolean().optional().describe('Enable or disable the skill'),
    triggers_commands: z.array(z.string()).optional().describe('New command triggers'),
    triggers_events: z.array(z.string()).optional().describe('New event triggers'),
  },
  async ({ name, description, keywords, body, patterns, priority, category, enabled, triggers_commands, triggers_events }) => {
    const skillPath = join(SKILLS_DIR, `${name}.md`);

    // Read existing
    let existingContent: string;
    try {
      existingContent = await readFile(skillPath, 'utf-8');
    } catch {
      return { content: [{ type: 'text' as const, text: `Skill "${name}" not found. Use create_skill to create it.` }], isError: true };
    }

    // Parse existing frontmatter
    const fmMatch = existingContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!fmMatch) {
      return { content: [{ type: 'text' as const, text: `Skill "${name}" has invalid format (no frontmatter found)` }], isError: true };
    }

    const existingBody = fmMatch[2]!;

    // Parse existing YAML fields (reuse simple parser logic)
    const yamlBlock = fmMatch[1]!;
    const existing: Record<string, unknown> = {};
    let currentKey = '';
    let currentArray: string[] | null = null;

    for (const line of yamlBlock.split('\n')) {
      const trimmed = line.trimEnd();
      if (trimmed.startsWith('  - ') || trimmed.startsWith('    - ')) {
        if (currentArray) {
          currentArray.push(trimmed.replace(/^\s*-\s*/, '').replace(/^["']|["']$/g, ''));
        }
        continue;
      }
      if (currentArray) {
        existing[currentKey] = currentArray;
        currentArray = null;
      }
      const kvMatch = trimmed.match(/^(\w+):\s*(.*)$/);
      if (kvMatch) {
        const [, key, rawValue] = kvMatch;
        const value = rawValue!.trim();
        currentKey = key!;
        if (value === '' || value === '[]') {
          currentArray = [];
        } else if (value.startsWith('[') && value.endsWith(']')) {
          existing[currentKey] = value.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
        } else if (value === 'true') {
          existing[currentKey] = true;
        } else if (value === 'false') {
          existing[currentKey] = false;
        } else if (/^\d+$/.test(value)) {
          existing[currentKey] = parseInt(value, 10);
        } else {
          existing[currentKey] = value.replace(/^["']|["']$/g, '');
        }
      }
    }
    if (currentArray) existing[currentKey] = currentArray;

    // Bump version
    const oldVersion = (existing.version as string) ?? '1.0';
    const vParts = oldVersion.split('.');
    const minor = parseInt(vParts[1] ?? '0', 10) + 1;
    const newVersion = `${vParts[0]}.${minor}`;

    // Merge — provided fields override existing
    const merged = buildSkillMarkdown({
      name,
      description: description ?? (existing.description as string) ?? '',
      keywords: keywords ?? (existing.keywords as string[]) ?? [],
      body: body ?? existingBody.trim(),
      patterns: patterns ?? (existing.patterns as string[]),
      priority: priority ?? (existing.priority as number),
      category: category ?? (existing.category as string),
      version: newVersion,
      enabled: enabled ?? (existing.enabled as boolean),
      triggers_commands: triggers_commands ?? (existing.triggers_commands as string[]),
      triggers_events: triggers_events ?? (existing.triggers_events as string[]),
    });

    try {
      await atomicWrite(skillPath, merged);
      await signalSkillRebuild();

      const changes: string[] = [];
      if (description !== undefined) changes.push('description');
      if (keywords !== undefined) changes.push('keywords');
      if (body !== undefined) changes.push('body');
      if (patterns !== undefined) changes.push('patterns');
      if (priority !== undefined) changes.push('priority');
      if (category !== undefined) changes.push('category');
      if (enabled !== undefined) changes.push(`enabled=${enabled}`);
      if (triggers_commands !== undefined) changes.push('triggers_commands');
      if (triggers_events !== undefined) changes.push('triggers_events');

      return { content: [{ type: 'text' as const, text: `Skill updated: ${name} (v${oldVersion} → v${newVersion})\nChanged: ${changes.join(', ')}\n\nSkill index will rebuild on next message match.` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Failed to update skill: ${msg}` }], isError: true };
    }
  },
);

// ── delete_skill ───────────────────────────────────────────

server.tool(
  'delete_skill',
  'Delete a Markdown skill from soul/skills/',
  {
    name: z.string().describe('Name of the skill to delete'),
  },
  async ({ name }) => {
    const skillPath = join(SKILLS_DIR, `${name}.md`);

    // Verify it exists
    try {
      await readFile(skillPath, 'utf-8');
    } catch {
      return { content: [{ type: 'text' as const, text: `Skill "${name}" not found` }], isError: true };
    }

    try {
      await unlink(skillPath);
      await signalSkillRebuild();
      return { content: [{ type: 'text' as const, text: `Skill deleted: ${name}` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Failed to delete skill: ${msg}` }], isError: true };
    }
  },
);

// ── list_skills ────────────────────────────────────────────

server.tool(
  'list_skills',
  'List all Markdown skills in soul/skills/',
  {},
  async () => {
    try {
      const files = await readdir(SKILLS_DIR);
      const mdFiles = files.filter((f) => f.endsWith('.md') && !f.startsWith('_') && !f.startsWith('.'));

      if (mdFiles.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No skills found in soul/skills/' }] };
      }

      const summaries: string[] = [];
      for (const file of mdFiles.sort()) {
        try {
          const content = await readFile(join(SKILLS_DIR, file), 'utf-8');
          const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
          const nameMatch = fmMatch?.[1]?.match(/^name:\s*(.+)$/m);
          const descMatch = fmMatch?.[1]?.match(/^description:\s*(.+)$/m);
          const enabledMatch = fmMatch?.[1]?.match(/^enabled:\s*(.+)$/m);
          const isEnabled = enabledMatch?.[1]?.trim() !== 'false';

          summaries.push(
            `${isEnabled ? '●' : '○'} ${nameMatch?.[1]?.trim() ?? file.replace('.md', '')} — ${descMatch?.[1]?.trim() ?? '(no description)'}`,
          );
        } catch {
          summaries.push(`? ${file} — (parse error)`);
        }
      }

      return { content: [{ type: 'text' as const, text: `Skills (${mdFiles.length}):\n${summaries.join('\n')}` }] };
    } catch {
      return { content: [{ type: 'text' as const, text: 'soul/skills/ directory not found' }] };
    }
  },
);

// ── report_search ─────────────────────────────────────────

server.tool(
  'report_search',
  'Search agent reports by keyword. Supports English and CJK (≥3 chars). Returns matching reports ranked by relevance.',
  {
    query: z.string().min(1).describe('Search query (keyword or phrase, min 3 chars for CJK)'),
    agent_name: z.string().optional().describe('Filter by agent name'),
    limit: z.number().min(1).max(50).optional().describe('Max results (default 10)'),
    full: z.boolean().optional().describe('Include full result text (default false, returns snippet only)'),
  },
  async ({ query, agent_name, limit, full }) => {
    try {
      const { searchReports } = await import('../agents/report-search.js');
      const results = searchReports({
        query,
        agentName: agent_name,
        limit: limit ?? 10,
        full: full ?? false,
      });

      if (results.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No reports found matching "${query}".` }],
        };
      }

      const lines = results.map((r, i) => {
        const parts = [
          `${i + 1}. [${r.timestamp}] ${r.agent_name}${r.task_id ? ` (task: ${r.task_id})` : ''}`,
          `   Score: ${r.score}`,
          `   Prompt: ${r.prompt_snippet || '(empty)'}`,
          `   Result: ${r.result_snippet || '(empty)'}`,
        ];
        if (r.trace_summary) {
          parts.push(`   Trace: ${r.trace_summary}`);
        }
        if (r.full_result) {
          parts.push(`   --- Full Result ---\n${r.full_result}`);
        }
        return parts.join('\n');
      });

      const header = `Found ${results.length} report(s) matching "${query}":\n`;
      return {
        content: [{ type: 'text' as const, text: header + '\n' + lines.join('\n\n') }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Search failed: ${msg}` }],
        isError: true,
      };
    }
  },
);

// ── get_dead_letters ──────────────────────────────────────

server.tool(
  'get_dead_letters',
  'Query the Dead Letter Queue for failed tasks. Returns recent DLQ entries with failure context for post-mortem analysis.',
  {
    agentName: z.string().optional().describe('Filter by agent name'),
    days: z.number().min(1).max(90).optional().describe('Look back N days (default 7)'),
    limit: z.number().min(1).max(100).optional().describe('Max results (default 20)'),
  },
  async ({ agentName, days, limit }) => {
    try {
      const { queryDeadLetters } = await import('../agents/monitoring/dead-letter.js');
      const since = new Date(Date.now() - (days ?? 7) * 86400000).toISOString();
      const entries = await queryDeadLetters({
        agentName,
        since,
        limit: limit ?? 20,
      });

      if (entries.length === 0) {
        const scope = agentName ? ` for agent "${agentName}"` : '';
        return {
          content: [{ type: 'text' as const, text: `No dead letters found${scope} in the last ${days ?? 7} day(s).` }],
        };
      }

      const lines = entries.map((e, i) => {
        const parts = [
          `${i + 1}. [${e.createdAt}] ${e.agentName} — ${e.source}`,
          `   Task: ${e.taskId.slice(0, 8)}`,
          `   Prompt: ${e.prompt.slice(0, 120)}${e.prompt.length > 120 ? '...' : ''}`,
          `   Cost: $${e.totalCost.toFixed(4)}`,
        ];
        if (e.pipelineRunId) parts.push(`   Pipeline: ${e.pipelineRunId.slice(0, 8)} / Stage: ${e.stageId ?? 'n/a'}`);
        if (e.failureHistory.length > 0) {
          parts.push(`   Failures (${e.failureHistory.length}):`);
          for (const f of e.failureHistory) {
            parts.push(`     #${f.attempt}: ${f.error.slice(0, 100)}${f.error.length > 100 ? '...' : ''}`);
          }
        }
        if (e.resolution) parts.push(`   Resolution: ${e.resolution}`);
        return parts.join('\n');
      });

      const header = `Dead Letter Queue — ${entries.length} entries (last ${days ?? 7} days)${agentName ? ` for "${agentName}"` : ''}:\n`;
      return {
        content: [{ type: 'text' as const, text: header + '\n' + lines.join('\n\n') }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `DLQ query failed: ${msg}` }],
        isError: true,
      };
    }
  },
);

// ── dispatch_task helpers ──────────────────────────────────

const MAX_CHAIN_DEPTH = 5;
const MAX_CHAIN_COST_USD = 10;

/** Search history.jsonl for a task by ID (reverse scan — newest first). */
async function findTaskInHistory(taskId: string): Promise<Record<string, unknown> | null> {
  const historyPath = join(SOUL_DIR, 'agent-tasks', 'history.jsonl');
  try {
    const raw = await readFile(historyPath, 'utf-8');
    const lines = raw.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      try {
        const task = JSON.parse(line) as Record<string, unknown>;
        if (task['id'] === taskId) return task;
      } catch { continue; }
    }
  } catch { /* file not found */ }
  return null;
}

/** Calculate total accumulated cost of a task chain by walking up parentTaskId links. */
async function calculateChainCost(taskId: string, queueTasks: Array<Record<string, unknown>>): Promise<number> {
  let totalCost = 0;
  let currentId: string | null = taskId;
  const visited = new Set<string>();

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const inQueue = queueTasks.find(t => t['id'] === currentId) as Record<string, unknown> | undefined;
    const task: Record<string, unknown> | null = inQueue ?? await findTaskInHistory(currentId);
    if (!task) break;
    totalCost += (task['costUsd'] as number) || 0;
    currentId = (task['parentTaskId'] as string | null | undefined) ?? null;
  }

  return totalCost;
}

// ── dispatch_task ─────────────────────────────────────────

const QUEUE_PATH = join(SOUL_DIR, 'agent-tasks', 'queue.json');
const DISPATCH_SIGNAL = join(SOUL_DIR, 'agent-tasks', '.dispatch');

server.tool(
  'dispatch_task',
  'Dispatch a background task to the worker scheduler. Returns immediately with task ID — does not block the current session. Use this instead of the Task tool when you want to delegate work without waiting.',
  {
    agentName: z.string().describe('Agent name (must match a config in soul/agents/, e.g. "deep-researcher", "blog-writer")'),
    prompt: z.string().describe('The task prompt for the agent'),
    priority: z.number().min(1).max(10).optional().describe('Priority 1-10 (default 5, higher = more urgent)'),
    parentTaskId: z.string().optional().describe('Parent task ID when an agent dispatches a sub-task (for chain tracking)'),
    originAgent: z.string().optional().describe('Name of the agent dispatching this sub-task'),
  },
  async ({ agentName, prompt, priority, parentTaskId, originAgent }) => {
    // 1. Validate agent config exists and is enabled
    const agentPath = join(SOUL_DIR, 'agents', `${agentName}.json`);
    try {
      const raw = await readFile(agentPath, 'utf-8');
      const cfg = JSON.parse(raw) as { enabled?: boolean };
      if (cfg.enabled === false) {
        return { content: [{ type: 'text' as const, text: `Agent "${agentName}" is disabled` }], isError: true };
      }
    } catch {
      return { content: [{ type: 'text' as const, text: `Agent "${agentName}" not found in soul/agents/` }], isError: true };
    }

    // 2. Load existing queue (or create empty)
    let queue: { version: number; tasks: Array<Record<string, unknown>> };
    try {
      const raw = await readFile(QUEUE_PATH, 'utf-8');
      queue = JSON.parse(raw) as typeof queue;
    } catch {
      queue = { version: 1, tasks: [] };
    }

    // 3. Dedup: skip if identical agent+prompt is already pending/running
    const isDupe = queue.tasks.some(
      (t) => t.agentName === agentName && t.prompt === prompt &&
        (t.status === 'pending' || t.status === 'running'),
    );
    if (isDupe) {
      return { content: [{ type: 'text' as const, text: `Task already queued for "${agentName}" with same prompt (dedup)` }] };
    }

    // 3b. Resolve parent task once (reused for chain protection + worktree inheritance)
    let parentTask: Record<string, unknown> | undefined;
    if (parentTaskId) {
      const parentInQueue = queue.tasks.find(t => t['id'] === parentTaskId);
      parentTask = (parentInQueue ?? await findTaskInHistory(parentTaskId)) ?? undefined;
    }

    let chainDepth = 0;
    if (parentTask) {
      chainDepth = ((parentTask['chainDepth'] as number | undefined) ?? 0) + 1;

      if (chainDepth > MAX_CHAIN_DEPTH) {
        return {
          content: [{ type: 'text' as const, text: `Chain depth ${chainDepth} exceeds max ${MAX_CHAIN_DEPTH}. Escalate to CTO instead of dispatching further.` }],
          isError: true,
        };
      }

      const chainCost = await calculateChainCost(parentTaskId!, queue.tasks);
      if (chainCost > MAX_CHAIN_COST_USD) {
        return {
          content: [{ type: 'text' as const, text: `Chain accumulated cost $${chainCost.toFixed(2)} exceeds max $${MAX_CHAIN_COST_USD}. Escalate to CTO.` }],
          isError: true,
        };
      }
    }

    // 4. Create task entry (same shape as AgentTask in worker-scheduler.ts)
    const taskId = randomUUID();
    const task: {
      id: string;
      agentName: string;
      prompt: string;
      status: string;
      priority: number;
      createdAt: string;
      startedAt: null;
      completedAt: null;
      workerId: null;
      result: null;
      error: null;
      costUsd: number;
      duration: number;
      parentTaskId: string | null;
      originAgent: string | null;
      chainDepth: number;
      worktreePath: string | null;
      branchName: string | null;
      source: 'agent-dispatch' | 'manual';
    } = {
      id: taskId,
      agentName,
      prompt,
      status: 'pending',
      priority: Math.max(1, Math.min(10, priority ?? 5)),
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      workerId: null,
      result: null,
      error: null,
      costUsd: 0,
      duration: 0,
      parentTaskId: parentTaskId ?? null,
      originAgent: originAgent ?? null,
      chainDepth,
      worktreePath: null,
      branchName: null,
      source: parentTaskId ? 'agent-dispatch' as const : 'manual' as const,
    };
    // Inherit worktree from parent task (for pipeline: programmer → reviewer → secretary)
    if (parentTask?.['worktreePath']) {
      task.worktreePath = parentTask['worktreePath'] as string;
      task.branchName = (parentTask['branchName'] as string) ?? null;
    }

    queue.tasks.push(task);

    // SQLite dual-write (Phase 3a sync)
    try {
      const db = getDb();
      db.prepare(
        `INSERT OR REPLACE INTO agent_tasks (id, agent_name, prompt, status, priority, source, created_at, started_at, completed_at, worker_id, result, error, cost_usd, duration, confidence, trace_summary, pipeline_id, stage_id, parent_task_id, chain_depth, retry_count, retry_after, depends_on, worktree_path, branch_name, trace, metadata, origin_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        task.id, task.agentName, task.prompt, task.status, task.priority,
        task.source, task.createdAt, task.startedAt, task.completedAt,
        task.workerId, task.result, task.error, task.costUsd, task.duration,
        null, null, null, null,
        task.parentTaskId, task.chainDepth,
        0, null, null,
        task.worktreePath, task.branchName,
        null, null, task.originAgent,
      );
    } catch {
      // Non-fatal: queue.json is the backup path
    }

    // 5. Atomic write queue
    const queueDir = dirname(QUEUE_PATH);
    await mkdir(queueDir, { recursive: true });
    await atomicWrite(QUEUE_PATH, JSON.stringify(queue, null, 2));

    // 6. Signal worker scheduler to process queue immediately
    await writeFile(DISPATCH_SIGNAL, new Date().toISOString(), 'utf-8');

    return {
      content: [{
        type: 'text' as const,
        text: `Task dispatched: ${taskId.slice(0, 8)}\nAgent: ${agentName}\nPriority: ${priority ?? 5}\n\nWorker scheduler will pick this up shortly.`,
      }],
    };
  },
);

// ── dispatch_pipeline ──────────────────────────────────────

server.tool(
  'dispatch_pipeline',
  'Start a multi-agent pipeline from a team template. Agents will automatically pass results to the next stage.',
  {
    teamName: z.string().describe('Team template name (must exist in soul/teams/, e.g. "content-pipeline")'),
    prompt: z.string().describe('The task prompt — will be passed to the first stage and available to all downstream stages'),
  },
  async ({ teamName, prompt }) => {
    // 1. Validate team template exists
    const templatePath = join(SOUL_DIR, 'teams', `${teamName}.json`);
    try {
      await readFile(templatePath, 'utf-8');
    } catch {
      return { content: [{ type: 'text' as const, text: `Team template "${teamName}" not found in soul/teams/` }], isError: true };
    }

    // 2. Dynamic import to avoid circular deps
    const { startPipeline } = await import('../agents/pipeline-engine.js');
    const run = await startPipeline(teamName, prompt);

    if (!run) {
      return { content: [{ type: 'text' as const, text: `Failed to start pipeline for team "${teamName}"` }], isError: true };
    }

    const stageNames = Object.values(run.stages).map(s => s.agentName).join(' → ');
    return {
      content: [{
        type: 'text' as const,
        text: `Pipeline started: ${run.id.slice(0, 8)}\nTeam: ${teamName}\nStages: ${stageNames}\n\nWorker scheduler will process stages automatically.`
      }]
    };
  }
);

// ── resume_pipeline ──────────────────────────────────────

server.tool(
  'resume_pipeline',
  'Resume an aborted or completed pipeline from a specific stage. Creates a new run that inherits completed stages and re-executes from the given stage onward.',
  {
    runId: z.string().describe('The original pipeline run ID to resume from'),
    fromStageId: z.string().describe('The stage ID to resume from (this stage and all subsequent stages will be re-executed)'),
  },
  async ({ runId, fromStageId }) => {
    const { resumePipeline } = await import('../agents/pipeline-engine.js');
    const run = await resumePipeline(runId, fromStageId);

    if (!run) {
      return {
        content: [{
          type: 'text' as const,
          text: `Failed to resume pipeline "${runId}" from stage "${fromStageId}". Possible reasons: pipeline still running, stage not found, or dependencies not completed.`,
        }],
        isError: true,
      };
    }

    const stageNames = Object.values(run.stages).map(s => `${s.stageId}(${s.status})`).join(' → ');
    return {
      content: [{
        type: 'text' as const,
        text: `Pipeline resumed: ${run.id.slice(0, 8)}\nOriginal: ${runId.slice(0, 8)}\nFrom stage: ${fromStageId}\nStages: ${stageNames}\n\nWorker scheduler will process stages automatically.`,
      }],
    };
  }
);

// ── Knowledge Base tools ──────────────────────────────────

const KNOWLEDGE_CATEGORIES = [
  'agent-config', 'deployment', 'wsl-environment', 'git-worktree',
  'pipeline', 'mcp-tools', 'api-integration', 'performance',
  'security', 'architecture', 'other',
] as const;

server.tool(
  'knowledge_write',
  'Write a knowledge entry to the persistent team knowledge base. Use this to record lessons learned, bugs encountered, and prevention rules.',
  {
    title: z.string().describe('One-line title describing the issue'),
    category: z.enum(KNOWLEDGE_CATEGORIES).describe('Knowledge category'),
    severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).describe('Issue severity'),
    tags: z.array(z.string()).max(10).describe('Tags for matching (max 10)'),
    relatedAgents: z.array(z.string()).optional().describe('Agents this knowledge is relevant to'),
    scope: z.enum(['global', 'targeted']).optional().describe('global = all agents, targeted = relatedAgents only (default: targeted)'),
    problem: z.string().describe('Problem description'),
    rootCause: z.string().optional().describe('Root cause analysis'),
    solution: z.string().optional().describe('How the problem was solved'),
    preventionRule: z.string().describe('One-line prevention rule (injected into agent prompts)'),
    context: z.string().optional().describe('Additional context (commit hash, cost, etc.)'),
    sourceAgent: z.string().optional().describe('Agent that discovered this'),
    sourceTaskId: z.string().optional().describe('Task ID where this was discovered'),
  },
  async ({ title, category, severity, tags, relatedAgents, scope, problem, rootCause, solution, preventionRule, context, sourceAgent, sourceTaskId }) => {
    try {
      const { addKnowledgeEntry } = await import('../agents/knowledge/knowledge-base.js');
      const id = await addKnowledgeEntry({
        title, category, severity, tags,
        relatedAgents: relatedAgents ?? [],
        scope: scope ?? 'targeted',
        problem,
        rootCause: rootCause ?? undefined,
        solution: solution ?? undefined,
        preventionRule,
        context: context ?? undefined,
        sourceAgent: sourceAgent ?? undefined,
        sourceTaskId: sourceTaskId ?? undefined,
      });
      return { content: [{ type: 'text' as const, text: `Knowledge entry created: ${id}\nTitle: ${title}\nSeverity: ${severity}\nScope: ${scope ?? 'targeted'}` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Failed to write knowledge: ${msg}` }], isError: true };
    }
  },
);

server.tool(
  'knowledge_search',
  'Search the team knowledge base for relevant past issues and prevention rules.',
  {
    query: z.string().describe('Search query (free text)'),
    agentName: z.string().optional().describe('Agent name for relevance scoring (targeted entries)'),
    category: z.string().optional().describe('Filter by category'),
    severity: z.string().optional().describe('Minimum severity (LOW, MEDIUM, HIGH, CRITICAL)'),
    limit: z.number().optional().describe('Max results (default 5)'),
  },
  async ({ query, agentName, category, severity, limit }) => {
    try {
      const { loadIndex, extractQueryTags, computeKBRelevance } = await import('../agents/knowledge/knowledge-base.js');
      const index = await loadIndex();
      const tags = extractQueryTags(query);
      const maxResults = limit ?? 5;

      const severityRank: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
      const minSeverityRank = severity ? (severityRank[severity] ?? 0) : 0;

      const results = index.entries
        .filter(e => e.status === 'active')
        .filter(e => !category || e.category === category)
        .filter(e => (severityRank[e.severity] ?? 0) >= minSeverityRank)
        .map(e => ({ entry: e, score: computeKBRelevance(e, agentName ?? '', tags) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults);

      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No matching knowledge entries found.' }] };
      }

      const text = results.map((r, i) =>
        `${i + 1}. [${r.entry.severity}] ${r.entry.title} (${r.entry.id})\n   Score: ${r.score.toFixed(2)} | Tags: ${r.entry.tags.join(', ')}\n   Rule: ${r.entry.preventionRule}`,
      ).join('\n\n');

      return { content: [{ type: 'text' as const, text: `Found ${results.length} entries:\n\n${text}` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Search failed: ${msg}` }], isError: true };
    }
  },
);

server.tool(
  'knowledge_read',
  'Read the full content of a knowledge base entry by ID.',
  {
    id: z.string().describe('Knowledge entry ID (e.g. "kb-2026-02-26-001")'),
  },
  async ({ id }) => {
    try {
      const { getEntry } = await import('../agents/knowledge/knowledge-base.js');
      const content = await getEntry(id);
      if (!content) {
        return { content: [{ type: 'text' as const, text: `Knowledge entry "${id}" not found.` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: content }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Read failed: ${msg}` }], isError: true };
    }
  },
);

server.tool(
  'knowledge_archive',
  'Archive a knowledge base entry (mark as no longer active).',
  {
    id: z.string().describe('Knowledge entry ID to archive'),
    reason: z.string().optional().describe('Reason for archiving'),
  },
  async ({ id, reason }) => {
    try {
      const { archiveEntry } = await import('../agents/knowledge/knowledge-base.js');
      const result = await archiveEntry(id, reason ?? undefined);
      if (!result.archived) {
        return { content: [{ type: 'text' as const, text: `Cannot archive "${id}": entry not found or already archived.` }], isError: true };
      }
      const text = `Archived: ${id}${reason ? ` (reason: ${reason})` : ''}${result.warning ? `\n${result.warning}` : ''}`;
      return { content: [{ type: 'text' as const, text: text }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Archive failed: ${msg}` }], isError: true };
    }
  },
);

// ── get_agent_trends ──────────────────────────────────────

server.tool(
  'get_agent_trends',
  'Get performance trend data for an agent over recent days. Shows cost, failure, and confidence trends with change percentages.',
  {
    agentName: z.string().describe('Agent name to query trends for'),
    days: z.number().min(1).max(90).optional().describe('Number of days to look back (default 7)'),
  },
  async ({ agentName, days }) => {
    try {
      const { getAgentTrends } = await import('../agents/monitoring/stats-snapshot.js');
      const trends = await getAgentTrends(agentName, days ?? 7);

      const lines: string[] = [
        `## Agent Trends: ${trends.agentName} (${trends.days} days)`,
        '',
      ];

      if (trends.costTrend.length === 0) {
        lines.push('No data available for this period.');
      } else {
        lines.push('### Cost');
        for (const p of trends.costTrend) {
          lines.push(`  ${p.date}: $${p.value.toFixed(4)}`);
        }

        lines.push('', '### Failures');
        for (const p of trends.failureTrend) {
          lines.push(`  ${p.date}: ${p.value}`);
        }

        lines.push('', '### Confidence');
        for (const p of trends.confidenceTrend) {
          lines.push(`  ${p.date}: ${p.value.toFixed(2)}`);
        }

        lines.push('', '### Summary');
        const s = trends.summary;
        if (s.costChangePercent !== null) lines.push(`  Cost change: ${s.costChangePercent > 0 ? '+' : ''}${s.costChangePercent}%`);
        if (s.failureChangePercent !== null) lines.push(`  Failure change: ${s.failureChangePercent > 0 ? '+' : ''}${s.failureChangePercent}%`);
        lines.push(`  ${s.recommendation}`);

        // ── Concept Drift Analysis ──
        if (trends.drift?.hasDrift) {
          lines.push('', '### Concept Drift (Page-Hinkley)');
          for (const d of trends.drift.drifts) {
            if (d.detected) {
              lines.push(`  **${d.metric}**: ${d.direction} drift detected (PH=${d.phStatistic.toFixed(2)})`);
            }
          }
        }
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Failed to get trends: ${msg}` }], isError: true };
    }
  },
);

// ── Start ───────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
