/**
 * One-time migration script — converts all existing JSONL reports
 * into Hexo posts for the report site.
 *
 * Usage: npx tsx src/report-site/migrate-reports.ts
 *
 * Does NOT deploy automatically. Run deploy separately:
 *   cd report && npx hexo generate && wrangler pages deploy public/ --project-name $CF_REPORT_PROJECT
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { reportToPost, type AgentReport } from './report-to-post.js';

const REPORTS_DIR = join(process.cwd(), 'soul', 'agent-reports');

async function migrate(): Promise<void> {
  console.log('Scanning soul/agent-reports/ for JSONL files...\n');

  let entries;
  try {
    entries = await readdir(REPORTS_DIR, { withFileTypes: true });
  } catch {
    console.error('Failed to read soul/agent-reports/ directory');
    process.exit(1);
  }

  let total = 0;
  let skipped = 0;
  let errors = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const agentDir = join(REPORTS_DIR, entry.name);
    const files = await readdir(agentDir);
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl')).sort();

    for (const file of jsonlFiles) {
      const raw = await readFile(join(agentDir, file), 'utf-8');
      for (const line of raw.trim().split('\n').filter(Boolean)) {
        try {
          const report = JSON.parse(line) as AgentReport;

          // Skip short/empty results (same threshold as /report command)
          if (!report.result || report.result.trim().length < 30) {
            skipped++;
            continue;
          }

          const slug = await reportToPost(report);
          if (slug) {
            total++;
            console.log(`  [${total}] ${slug}`);
          } else {
            errors++;
          }
        } catch {
          skipped++;
        }
      }
    }
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Migration complete:`);
  console.log(`  Posts created: ${total}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Errors: ${errors}`);
  console.log(`\nNext steps:`);
  console.log(`  cd report && npm install && npx hexo generate`);
  console.log(`  wrangler pages deploy public/ --project-name ${process.env.CF_REPORT_PROJECT || process.env.CF_REPORT_PROJECT || 'my-report'}`);
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
