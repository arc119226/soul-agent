/**
 * CLAUDE.md auto-sync — updates managed sections between marker comments.
 * Three sections: Directory Structure, Environment Variables, Exit Code Semantics.
 * Only replaces content within markers; never touches human-written text.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../core/logger.js';
import { ok, fail, type Result } from '../result.js';

const PROJECT_ROOT = process.cwd();
const CLAUDE_MD_PATH = join(PROJECT_ROOT, 'CLAUDE.md');

interface SyncResult {
  updated: boolean;
  sections: string[];
}

/** Replace content between markers in the document */
function replaceMarkerContent(
  doc: string,
  startMarker: string,
  endMarker: string,
  newContent: string,
): { result: string; changed: boolean } {
  const startIdx = doc.indexOf(startMarker);
  const endIdx = doc.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return { result: doc, changed: false };
  }

  const before = doc.slice(0, startIdx + startMarker.length);
  const after = doc.slice(endIdx);
  const oldContent = doc.slice(startIdx + startMarker.length, endIdx);

  if (oldContent.trim() === newContent.trim()) {
    return { result: doc, changed: false };
  }

  return { result: `${before}\n${newContent}\n${after}`, changed: true };
}

/** Scan src/ subdirectories and generate directory structure */
async function buildDirectorySection(): Promise<string> {
  const srcDir = join(PROJECT_ROOT, 'src');
  const lines: string[] = [
    '```',
    'soul/           — Bot\'s soul (platform-agnostic, human-readable, portable)',
    'src/            — Source code (the shell)',
  ];

  try {
    const entries = await readdir(srcDir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    for (const dir of dirs) {
      // Read .ts files to infer description
      const dirPath = join(srcDir, dir);
      try {
        const files = await readdir(dirPath);
        const tsFiles = files.filter((f) => f.endsWith('.ts')).map((f) => f.replace('.ts', ''));
        const desc = tsFiles.slice(0, 5).join(', ');
        const padded = `  ${dir}/`.padEnd(16);
        lines.push(`${padded}— ${desc}${tsFiles.length > 5 ? ', ...' : ''}`);
      } catch {
        lines.push(`  ${dir}/`);
      }
    }

    lines.push('plugins/        — Dynamic plugin directory (hot-loaded)');
    lines.push('data/           — Runtime transient data (not soul)');
    lines.push('```');
  } catch (err) {
    logger.warn('claude-md-sync', 'Failed to scan src/ directories', err);
    return '';
  }

  return lines.join('\n');
}

/** Extract environment variable keys from config.ts and .env.example */
async function buildEnvSection(): Promise<string> {
  const lines: string[] = [];

  try {
    // Read config.ts to extract keys from configSchema
    const configSrc = await readFile(join(PROJECT_ROOT, 'src', 'config.ts'), 'utf-8');
    const keyMatches = configSrc.match(/^\s+(\w+):/gm);
    const configKeys = keyMatches
      ? keyMatches.map((m) => m.trim().replace(/:$/, ''))
      : [];

    // Read .env.example for descriptions
    const envExample = await readFile(join(PROJECT_ROOT, '.env.example'), 'utf-8');
    const envDescriptions = new Map<string, string>();
    let lastComment = '';
    for (const line of envExample.split('\n')) {
      if (line.startsWith('#') && !line.startsWith('# ───')) {
        lastComment = line.replace(/^#\s*/, '').trim();
      } else if (line.includes('=') && !line.startsWith('#')) {
        const key = line.split('=')[0]!.trim();
        if (lastComment) {
          envDescriptions.set(key, lastComment);
        }
        lastComment = '';
      } else {
        lastComment = '';
      }
    }

    lines.push('See `.env.example` for all options. Key ones:');
    for (const key of configKeys) {
      const desc = envDescriptions.get(key);
      if (desc) {
        lines.push(`- \`${key}\` — ${desc}`);
      }
    }
  } catch (err) {
    logger.warn('claude-md-sync', 'Failed to extract env vars', err);
    return '';
  }

  return lines.join('\n');
}

/** Grep src/ for process.exit calls and build exit code table */
async function buildExitCodeSection(): Promise<string> {
  try {
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);

    const { stdout } = await execAsync(
      'grep -rn "process\\.exit(" src/ --include="*.ts"',
      { cwd: PROJECT_ROOT, timeout: 10_000 },
    );

    const exitCodes = new Map<number, string[]>();
    for (const line of stdout.split('\n')) {
      const match = line.match(/process\.exit\((\d+)\)/);
      if (match) {
        const code = parseInt(match[1]!, 10);
        const file = line.split(':')[0]?.replace('src/', '') ?? 'unknown';
        if (!exitCodes.has(code)) exitCodes.set(code, []);
        exitCodes.get(code)!.push(file);
      }
    }

    const lines: string[] = [
      '| Code | Meaning | Wrapper Behavior |',
      '|------|---------|-----------------|',
    ];

    // Known semantics
    const semantics: Record<number, { meaning: string; behavior: string }> = {
      0: { meaning: 'Sleep (shutdown)', behavior: 'Stop, wait for manual start' },
      42: { meaning: 'Molt (restart)', behavior: 'Auto-restart after 2s' },
      1: { meaning: 'Error', behavior: 'Stop, needs manual intervention' },
    };

    const sortedCodes = [...exitCodes.keys()].sort((a, b) => a - b);
    for (const code of sortedCodes) {
      const info = semantics[code] ?? { meaning: 'Unknown', behavior: 'Unknown' };
      lines.push(`| ${code}    | ${info.meaning} | ${info.behavior} |`);
    }

    // Add known codes not found in grep
    for (const [code, info] of Object.entries(semantics)) {
      if (!exitCodes.has(Number(code))) {
        lines.push(`| ${code}    | ${info.meaning} | ${info.behavior} |`);
      }
    }

    return lines.join('\n');
  } catch (err) {
    logger.warn('claude-md-sync', 'Failed to extract exit codes', err);
    return '';
  }
}

/** Main sync entry — updates all managed sections in CLAUDE.md */
export async function syncClaudeMd(
  _filesChanged: string[],
): Promise<Result<SyncResult>> {
  try {
    let doc = await readFile(CLAUDE_MD_PATH, 'utf-8');
    const updatedSections: string[] = [];

    // Sync Directory Structure
    const dirContent = await buildDirectorySection();
    if (dirContent) {
      const { result, changed } = replaceMarkerContent(
        doc,
        '<!-- AUTO:DIR-START -->',
        '<!-- AUTO:DIR-END -->',
        dirContent,
      );
      if (changed) {
        doc = result;
        updatedSections.push('directory');
      }
    }

    // Sync Environment Variables
    const envContent = await buildEnvSection();
    if (envContent) {
      const { result, changed } = replaceMarkerContent(
        doc,
        '<!-- AUTO:ENV-START -->',
        '<!-- AUTO:ENV-END -->',
        envContent,
      );
      if (changed) {
        doc = result;
        updatedSections.push('env');
      }
    }

    // Sync Exit Code Semantics
    const exitContent = await buildExitCodeSection();
    if (exitContent) {
      const { result, changed } = replaceMarkerContent(
        doc,
        '<!-- AUTO:EXIT-START -->',
        '<!-- AUTO:EXIT-END -->',
        exitContent,
      );
      if (changed) {
        doc = result;
        updatedSections.push('exit-codes');
      }
    }

    if (updatedSections.length > 0) {
      await writeFile(CLAUDE_MD_PATH, doc, 'utf-8');
      logger.info('claude-md-sync', `Updated CLAUDE.md sections: ${updatedSections.join(', ')}`);
    }

    return ok('CLAUDE.md sync complete', {
      updated: updatedSections.length > 0,
      sections: updatedSections,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('claude-md-sync', `CLAUDE.md sync failed: ${msg}`);
    return fail(`CLAUDE.md sync failed: ${msg}`);
  }
}
