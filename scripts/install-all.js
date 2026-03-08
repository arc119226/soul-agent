// scripts/install-all.js — Install dependencies for sub-projects
// Runs as postinstall hook. Pure Node.js — no tsx dependency.

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const SUBPROJECTS = ['blog', 'report'];

for (const dir of SUBPROJECTS) {
  const pkgPath = join(ROOT, dir, 'package.json');
  if (!existsSync(pkgPath)) continue;

  // Skip if already installed (node_modules exists and has content)
  const nmPath = join(ROOT, dir, 'node_modules');
  if (existsSync(nmPath)) {
    console.log(`  ✓ ${dir}/ dependencies already installed`);
    continue;
  }

  console.log(`  Installing ${dir}/ dependencies...`);
  try {
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: join(ROOT, dir),
      stdio: 'inherit',
      timeout: 120_000,
    });
    console.log(`  ✓ ${dir}/ done`);
  } catch (err) {
    console.error(`  ✗ ${dir}/ install failed:`, err.message);
    // Don't fail the whole postinstall — sub-projects are optional
  }
}
