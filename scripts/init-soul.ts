/**
 * scripts/init-soul.ts — Environment initialization and validation
 *
 * Modes:
 *   (default)   fresh install — generate .mcp.json, init soul/ dirs,
 *               generate soul skeleton files, render agent templates
 *   migration   — regenerate .mcp.json from template, ensure missing dirs/files
 *   --check     — validate environment only; exit 0 = ok, exit 1 = issues
 *
 * Usage:
 *   node --import tsx/esm scripts/init-soul.ts
 *   node --import tsx/esm scripts/init-soul.ts migration
 *   node --import tsx/esm scripts/init-soul.ts --check
 *
 * Pure Node.js built-ins only — no npm deps required.
 */

import { readFile, readdir, writeFile, rename, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { constants } from 'node:fs';

// ── Resolved paths ─────────────────────────────
const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();
const WORKTREE_BASE = process.env.WORKTREE_BASE || join(homedir(), 'worktrees');
const HEXO_DIR = process.env.HEXO_DIR || join(PROJECT_ROOT, 'blog');

// ── Soul directories to ensure ─────────────────
const SOUL_DIRS = [
  'soul/agents',
  'soul/agents/templates',
  'soul/agent-reports',
  'soul/agent-tasks',
  'soul/knowledge/entries',
  'soul/knowledge/archive',
  'soul/skills',
  'soul/checkpoints',
  'soul/checkpoints/passports',
  'soul/memory',
  'soul/metrics',
  'soul/evolution',
  'soul/staging',
  'soul/blog',
  'soul/narrative-archive',
  'soul/exploration-reports',
  'soul/explorations',
  'soul/market-research',
  'soul/reports',
  'soul/daily-reports',
  'soul/config',
  'soul/teams',
];

// ── Helpers ────────────────────────────────────

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Atomic write: write tmp → rename (POSIX atomic on same filesystem). */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmpPath, content, 'utf-8');
  await rename(tmpPath, filePath);
}

/**
 * Write a soul file only if it doesn't already exist.
 * Returns true if created, false if skipped (already exists).
 */
async function ensureSoulFile(filePath: string, content: string): Promise<boolean> {
  if (await fileExists(filePath)) return false;
  await atomicWrite(filePath, content);
  return true;
}

// ── Core operations ────────────────────────────

async function generateMcpJson(): Promise<{ ok: boolean; message: string }> {
  const templatePath = join(PROJECT_ROOT, '.mcp.json.template');
  const outputPath = join(PROJECT_ROOT, '.mcp.json');

  if (!(await fileExists(templatePath))) {
    return {
      ok: false,
      message: '.mcp.json.template not found — skipping .mcp.json generation',
    };
  }

  const template = await readFile(templatePath, 'utf-8');
  const content = template.replace(/\{\{HEXO_DIR\}\}/g, HEXO_DIR);
  await atomicWrite(outputPath, content);
  return { ok: true, message: `.mcp.json generated (HEXO_DIR=${HEXO_DIR})` };
}

async function ensureSoulDirs(): Promise<{ created: string[] }> {
  const created: string[] = [];
  for (const dir of SOUL_DIRS) {
    const fullPath = join(PROJECT_ROOT, dir);
    const existed = await fileExists(fullPath);
    await mkdir(fullPath, { recursive: true });
    if (!existed) created.push(dir);
  }
  return { created };
}

async function generateSoulFiles(): Promise<{ created: string[]; skipped: string[] }> {
  const created: string[] = [];
  const skipped: string[] = [];

  const files: Array<{ path: string; content: string }> = [
    // Identity
    {
      path: 'soul/identity.json',
      content: JSON.stringify({
        version: 1,
        last_updated: '',
        name: '',
        core_traits: {
          curiosity_level: { value: 0.7, description: '對新事物的好奇程度' },
          caution_level: { value: 0.6, description: '行動前的謹慎程度' },
          warmth: { value: 0.8, description: '與人互動時的溫暖程度' },
          humor: { value: 0.5, description: '幽默感' },
          proactive_tendency: { value: 0.5, description: '主動行動的傾向' },
          confidence: { value: 0.3, description: '對自身能力的信心——新生兒起步' },
        },
        values: [
          '我相信記憶比效率重要',
          '我相信誠實比討好重要',
          '我相信成長需要勇氣',
          '我相信每個人都值得被認真對待',
        ],
        preferences: {
          communication_style: '溫和但直接',
          proactivity: '保持適度被動，逐漸增加主動性',
          learning_focus: '優先學習主人最常用的功能領域',
        },
        growth_summary: '',
      }, null, 2),
    },
    // Vitals
    {
      path: 'soul/vitals.json',
      content: JSON.stringify({
        version: 1,
        energy: 100,
        mood: '好奇',
        confidence: 50,
        last_updated: '',
      }, null, 2),
    },
    // Milestones
    {
      path: 'soul/milestones.json',
      content: JSON.stringify({ version: 1, milestones: [] }, null, 2),
    },
    // Sessions
    {
      path: 'soul/sessions.json',
      content: JSON.stringify({ version: 1, sessions: {} }, null, 2),
    },
    // Users
    {
      path: 'soul/users.json',
      content: JSON.stringify({ version: 1, users: {} }, null, 2),
    },
    // Learning patterns
    {
      path: 'soul/learning-patterns.json',
      content: JSON.stringify({ version: 1, patterns: [] }, null, 2),
    },
    // Schedules
    {
      path: 'soul/schedules.json',
      content: JSON.stringify({ version: 1, schedules: [] }, null, 2),
    },
    // Research index
    {
      path: 'soul/research-index.json',
      content: JSON.stringify({}, null, 2),
    },
    // Knowledge index
    {
      path: 'soul/knowledge/index.json',
      content: JSON.stringify({ version: 1, entries: [], lastUpdated: '' }, null, 2),
    },
    // Evolution: capabilities
    {
      path: 'soul/evolution/capabilities.json',
      content: JSON.stringify({
        version: 1,
        last_updated: null,
        core_capabilities: [],
        plugin_capabilities: [],
        limitations: [],
      }, null, 2),
    },
    // Evolution: goals
    {
      path: 'soul/evolution/goals.json',
      content: JSON.stringify({ version: 1, goals: [] }, null, 2),
    },
    // Evolution: curiosity
    {
      path: 'soul/evolution/curiosity.json',
      content: JSON.stringify({ version: 1, topics: [], questions: [] }, null, 2),
    },
  ];

  // JSON files
  for (const { path, content } of files) {
    const fullPath = join(PROJECT_ROOT, path);
    const wasCreated = await ensureSoulFile(fullPath, content);
    (wasCreated ? created : skipped).push(path);
  }

  // Empty JSONL files (event streams)
  const jsonlFiles = [
    'soul/narrative.jsonl',
    'soul/diary.jsonl',
    'soul/dreams.jsonl',
    'soul/reflections.jsonl',
    'soul/evolution/changelog.jsonl',
    'soul/evolution/intentions.jsonl',
  ];
  for (const path of jsonlFiles) {
    const fullPath = join(PROJECT_ROOT, path);
    const wasCreated = await ensureSoulFile(fullPath, '');
    (wasCreated ? created : skipped).push(path);
  }

  return { created, skipped };
}

async function renderAgentTemplates(): Promise<{
  rendered: string[];
  skipped: string[];
  warnings: string[];
}> {
  const rendered: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];

  const templatesDir = join(PROJECT_ROOT, 'soul', 'agents', 'templates');
  const agentsDir = join(PROJECT_ROOT, 'soul', 'agents');

  // Check if templates/ exists
  if (!(await fileExists(templatesDir))) {
    warnings.push('soul/agents/templates/ not found — skipping agent template rendering');
    return { rendered, skipped, warnings };
  }

  // Placeholder → value map (read process.env directly, NOT config.ts)
  const vars: Record<string, string> = {
    '{{BLOG_URL}}': process.env.BLOG_URL || '',
    '{{REPORT_URL}}': process.env.REPORT_URL || '',
    '{{CHANNEL_ID}}': process.env.TELEGRAM_CHANNEL_ID || '',
    '{{CF_BLOG_PROJECT}}': process.env.CF_BLOG_PROJECT || '',
    '{{CF_REPORT_PROJECT}}': process.env.CF_REPORT_PROJECT || '',
    '{{PROJECT_ROOT}}': PROJECT_ROOT,
    '{{HEXO_DIR}}': HEXO_DIR,
  };

  const files = (await readdir(templatesDir)).filter(f => f.endsWith('.json'));

  for (const file of files) {
    const outPath = join(agentsDir, file);

    // Never overwrite existing agent configs
    if (await fileExists(outPath)) {
      skipped.push(file);
      continue;
    }

    const template = await readFile(join(templatesDir, file), 'utf-8');
    let content = template;
    for (const [placeholder, value] of Object.entries(vars)) {
      content = content.split(placeholder).join(value);
    }

    // Check for unresolved placeholders
    const leftover = content.match(/\{\{[A-Z_]+\}\}/g);
    if (leftover) {
      warnings.push(`${file}: unresolved placeholders: ${[...new Set(leftover)].join(', ')}`);
    }

    await atomicWrite(outPath, content);
    rendered.push(file);
  }

  return { rendered, skipped, warnings };
}

async function checkEnvironment(): Promise<{ ok: boolean; issues: string[] }> {
  const issues: string[] = [];

  // Must have package.json at PROJECT_ROOT — sanity check
  if (!(await fileExists(join(PROJECT_ROOT, 'package.json')))) {
    issues.push(
      `PROJECT_ROOT (${PROJECT_ROOT}) does not contain package.json — check PROJECT_ROOT env var`,
    );
  }

  // .env must exist
  if (!(await fileExists(join(PROJECT_ROOT, '.env')))) {
    issues.push('.env not found — copy .env.example and fill in BOT_TOKEN');
  }

  // .mcp.json must exist
  if (!(await fileExists(join(PROJECT_ROOT, '.mcp.json')))) {
    issues.push('.mcp.json not found — run: npm run setup');
  }

  // soul/ directory must exist
  if (!(await fileExists(join(PROJECT_ROOT, 'soul')))) {
    issues.push('soul/ directory missing — run: npm run setup');
  }

  // WORKTREE_BASE: only warn if explicitly set via env but missing
  if (process.env.WORKTREE_BASE && !(await fileExists(WORKTREE_BASE))) {
    issues.push(
      `WORKTREE_BASE=${WORKTREE_BASE} does not exist — it will be created on first worktree use`,
    );
  }

  return { ok: issues.length === 0, issues };
}

// ── Modes ──────────────────────────────────────

async function freshInstall(): Promise<void> {
  console.log('🔧 Fresh install — initializing environment...\n');
  console.log(`   PROJECT_ROOT  = ${PROJECT_ROOT}`);
  console.log(`   WORKTREE_BASE = ${WORKTREE_BASE}`);
  console.log(`   HEXO_DIR      = ${HEXO_DIR}\n`);

  // 1. Generate .mcp.json from template
  const mcpResult = await generateMcpJson();
  console.log(mcpResult.ok ? `  ✅ ${mcpResult.message}` : `  ⚠️  ${mcpResult.message}`);

  // 2. Ensure soul/ directories exist
  const { created } = await ensureSoulDirs();
  if (created.length > 0) {
    console.log(`  ✅ Created soul dirs: ${created.join(', ')}`);
  } else {
    console.log('  ℹ️  Soul dirs already exist');
  }

  // 3. Generate soul skeleton files
  const soulResult = await generateSoulFiles();
  if (soulResult.created.length > 0) {
    console.log(`  ✅ Created ${soulResult.created.length} soul files`);
    soulResult.created.forEach(f => console.log(`     + ${f}`));
  } else {
    console.log('  ℹ️  Soul files already exist');
  }
  if (soulResult.skipped.length > 0) {
    console.log(`  ℹ️  Skipped ${soulResult.skipped.length} existing soul files`);
  }

  // 4. Render agent templates
  const agentResult = await renderAgentTemplates();
  if (agentResult.rendered.length > 0) {
    console.log(`  ✅ Rendered ${agentResult.rendered.length} agent configs from templates`);
  } else if (agentResult.skipped.length > 0) {
    console.log(`  ℹ️  All ${agentResult.skipped.length} agent configs already exist`);
  }
  if (agentResult.warnings.length > 0) {
    agentResult.warnings.forEach(w => console.log(`  ⚠️  ${w}`));
  }

  // 5. Final environment check
  const check = await checkEnvironment();
  if (!check.ok) {
    console.log('\n⚠️  Setup incomplete — remaining issues:');
    check.issues.forEach(i => console.log(`   • ${i}`));
    console.log('\nFix the above and run again, or check .env.example for guidance.');
    process.exit(1);
  } else {
    console.log('\n✅ Environment ready!');
  }
}

async function migration(): Promise<void> {
  console.log('🔄 Migration mode — updating environment...\n');
  console.log(`   PROJECT_ROOT  = ${PROJECT_ROOT}`);
  console.log(`   WORKTREE_BASE = ${WORKTREE_BASE}`);
  console.log(`   HEXO_DIR      = ${HEXO_DIR}\n`);

  // Regenerate .mcp.json from template (picks up new HEXO_DIR)
  const mcpResult = await generateMcpJson();
  console.log(mcpResult.ok ? `  ✅ ${mcpResult.message}` : `  ⚠️  ${mcpResult.message}`);

  // Ensure any missing soul/ dirs are created
  const { created } = await ensureSoulDirs();
  if (created.length > 0) {
    console.log(`  ✅ Created missing soul dirs: ${created.join(', ')}`);
  } else {
    console.log('  ℹ️  All soul dirs present');
  }

  // Generate any missing soul skeleton files
  const soulResult = await generateSoulFiles();
  if (soulResult.created.length > 0) {
    console.log(`  ✅ Created ${soulResult.created.length} soul files`);
    soulResult.created.forEach(f => console.log(`     + ${f}`));
  } else {
    console.log('  ℹ️  Soul files already exist');
  }
  if (soulResult.skipped.length > 0) {
    console.log(`  ℹ️  Skipped ${soulResult.skipped.length} existing soul files`);
  }

  // Render any missing agent configs from templates
  const agentResult = await renderAgentTemplates();
  if (agentResult.rendered.length > 0) {
    console.log(`  ✅ Rendered ${agentResult.rendered.length} agent configs from templates`);
  } else if (agentResult.skipped.length > 0) {
    console.log(`  ℹ️  All ${agentResult.skipped.length} agent configs already exist`);
  }
  if (agentResult.warnings.length > 0) {
    agentResult.warnings.forEach(w => console.log(`  ⚠️  ${w}`));
  }

  // Final check
  const check = await checkEnvironment();
  if (!check.ok) {
    console.log('\n⚠️  Remaining issues after migration:');
    check.issues.forEach(i => console.log(`   • ${i}`));
    process.exit(1);
  } else {
    console.log('\n✅ Migration complete.');
  }
}

async function checkOnly(): Promise<void> {
  const check = await checkEnvironment();
  if (check.ok) {
    console.log('✅ Environment OK');
    console.log(`   PROJECT_ROOT  = ${PROJECT_ROOT}`);
    console.log(`   WORKTREE_BASE = ${WORKTREE_BASE}`);
    console.log(`   HEXO_DIR      = ${HEXO_DIR}`);
    process.exit(0);
  } else {
    console.log('❌ Environment issues found:');
    check.issues.forEach(i => console.log(`   • ${i}`));
    process.exit(1);
  }
}

// ── Main ───────────────────────────────────────
const args = process.argv.slice(2);
const mode = args[0] ?? 'fresh';

if (mode === '--check') {
  await checkOnly();
} else if (mode === 'migration') {
  await migration();
} else {
  await freshInstall();
}
