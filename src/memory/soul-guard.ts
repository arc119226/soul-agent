import { resolve, relative } from 'node:path';
import { ok, fail, type Result } from '../result.js';

const PROJECT_ROOT = process.cwd();

/** Paths that are sacred — evolution must never touch these */
const BLOCKED_PREFIXES = [
  'soul/',
  'src/memory/',
  'src/identity/',
];

/** Individual files that are always protected */
const BLOCKED_FILES = new Set([
  'soul/genesis.md',
  'soul/identity.json',
  'soul/narrative.jsonl',
  'soul/users.json',
  'soul/vitals.json',
  'soul/milestones.json',
]);

function normalizePath(filePath: string): string {
  const abs = resolve(PROJECT_ROOT, filePath);
  const rel = relative(PROJECT_ROOT, abs);
  // Ensure forward slashes and no leading ./
  return rel.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Check if a path is within the soul/ directory */
export function isSoulPath(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  return normalized.startsWith('soul/') || normalized === 'soul';
}

/** Check if a path is a memory module source file */
export function isMemoryModulePath(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  return (
    normalized.startsWith('src/memory/') ||
    normalized.startsWith('src/identity/')
  );
}

/** Check if a path is in any blocked prefix */
function isBlocked(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  if (BLOCKED_FILES.has(normalized)) return true;
  return BLOCKED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Validate that a set of files targeted by evolution are safe to modify.
 * Returns Fail if any file is in a protected area.
 */
export function validateEvolutionTarget(files: string[]): Result {
  const violations: string[] = [];

  for (const file of files) {
    if (isBlocked(file)) {
      violations.push(file);
    }
  }

  if (violations.length > 0) {
    return fail(
      `Evolution blocked: ${violations.length} file(s) in protected area`,
      `Protected files: ${violations.join(', ')}. ` +
        `The soul/ directory, src/memory/, and src/identity/ are sacred and cannot be modified by evolution.`,
    );
  }

  return ok('All files are safe for evolution');
}

/** Get the list of blocked prefixes (for display purposes) */
export function getBlockedPrefixes(): string[] {
  return [...BLOCKED_PREFIXES];
}
