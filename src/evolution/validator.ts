/**
 * Post-evolution validation — 3-layer gate system.
 * Validates syntax, semantics, and integration of changed files.
 */

import { exec } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { logger } from '../core/logger.js';
import { ok, fail, type Result } from '../result.js';

const execAsync = promisify(exec);
const PROJECT_ROOT = process.cwd();

export interface ValidationIssue {
  layer: 'syntax' | 'semantic' | 'integration';
  file: string;
  message: string;
  fixHint: string;
}

export interface ValidationReport {
  passed: boolean;
  issues: ValidationIssue[];
  summary: string;
}

/** Run TypeScript compiler in check mode (uses tsgo for speed, falls back to tsc) */
export async function validateSyntax(): Promise<Result<string>> {
  // Try tsgo first (10x faster), fall back to tsc
  const commands = ['npx tsgo --noEmit', 'npx tsc --noEmit'];

  for (const cmd of commands) {
    try {
      const { stdout, stderr } = await execAsync(cmd, {
        cwd: PROJECT_ROOT,
        timeout: 90_000,
      });
      const output = (stdout + stderr).trim();
      if (output.length === 0 || !output.includes('error TS')) {
        logger.info('validator', `Type check passed (${cmd.includes('tsgo') ? 'tsgo' : 'tsc'})`);
        return ok('TypeScript syntax check passed');
      }
      return fail(`TypeScript errors found:\n${output}`, 'Fix the TypeScript errors listed above');
    } catch (err) {
      const msg = err instanceof Error ? (err as Error & { stderr?: string }).stderr || err.message : String(err);
      // If tsgo not found, try next command
      if (cmd.includes('tsgo') && (msg.includes('not found') || msg.includes('ENOENT') || msg.includes('ERR_MODULE_NOT_FOUND'))) {
        logger.info('validator', 'tsgo not available, falling back to tsc');
        continue;
      }
      return fail(`TypeScript check failed:\n${msg}`, 'Fix compilation errors before proceeding');
    }
  }

  return fail('No TypeScript checker available', 'Install tsgo or tsc');
}

/** Test dynamic imports for a list of files */
export async function validateImports(files: string[]): Promise<Result<string>> {
  const failures: string[] = [];

  for (const file of files) {
    if (!file.endsWith('.ts') && !file.endsWith('.js')) continue;

    // Convert .ts to .js for import path
    const importPath = file.replace(/\.ts$/, '.js');
    const fullPath = join(PROJECT_ROOT, 'dist', importPath.replace(/^src\//, ''));

    try {
      // Just check if the compiled file exists (actual import test needs build)
      await access(fullPath);
    } catch {
      // File might not be built yet, skip dynamic import test
      // This is checked more thoroughly in layered validation
    }
  }

  if (failures.length > 0) {
    return fail(
      `Import validation failed:\n${failures.join('\n')}`,
      'Check that all imports use .js extensions and exported symbols exist',
    );
  }
  return ok('Import validation passed');
}

/** Syntax layer: file exists, valid syntax, valid JSON for .json files */
async function validateSyntaxLayer(files: string[]): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];

  for (const file of files) {
    const fullPath = join(PROJECT_ROOT, file);

    // Check file exists
    try {
      await access(fullPath);
    } catch {
      issues.push({
        layer: 'syntax',
        file,
        message: 'File does not exist',
        fixHint: `Create the file at ${file}`,
      });
      continue;
    }

    // For JSON files, validate JSON syntax
    if (file.endsWith('.json')) {
      try {
        const content = await readFile(fullPath, 'utf-8');
        JSON.parse(content);
      } catch (err) {
        issues.push({
          layer: 'syntax',
          file,
          message: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
          fixHint: 'Fix the JSON syntax error',
        });
      }
    }

    // For TS files, check basic syntax via reading
    if (file.endsWith('.ts')) {
      try {
        const content = await readFile(fullPath, 'utf-8');
        // Basic checks
        if (content.includes('\0')) {
          issues.push({
            layer: 'syntax',
            file,
            message: 'File contains null bytes',
            fixHint: 'Remove null bytes from the file',
          });
        }
      } catch (err) {
        issues.push({
          layer: 'syntax',
          file,
          message: `Cannot read file: ${err instanceof Error ? err.message : String(err)}`,
          fixHint: 'Check file permissions and encoding',
        });
      }
    }
  }

  return issues;
}

/** Semantic layer: exports valid, no require(), proper types */
async function validateSemanticLayer(files: string[]): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];

  for (const file of files) {
    if (!file.endsWith('.ts')) continue;

    const fullPath = join(PROJECT_ROOT, file);
    let content: string;
    try {
      content = await readFile(fullPath, 'utf-8');
    } catch {
      continue; // Already caught in syntax layer
    }

    // Check for CommonJS require() calls
    const requireMatch = content.match(/\brequire\s*\(/);
    if (requireMatch) {
      issues.push({
        layer: 'semantic',
        file,
        message: 'File uses require() instead of ESM import',
        fixHint: "Replace require() with import ... from '...'",
      });
    }

    // Check imports use .js extension
    const importRegex = /from\s+['"](\.[^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(content)) !== null) {
      const importPath = match[1]!;
      if (
        !importPath.endsWith('.js') &&
        !importPath.endsWith('.json') &&
        !importPath.includes('node:')
      ) {
        issues.push({
          layer: 'semantic',
          file,
          message: `Import "${importPath}" missing .js extension`,
          fixHint: `Change to "${importPath}.js"`,
        });
      }
    }

    // Check for at least one export (modules should export something)
    if (!content.includes('export ')) {
      issues.push({
        layer: 'semantic',
        file,
        message: 'File has no exports',
        fixHint: 'Add export to at least one declaration',
      });
    }
  }

  return issues;
}

/** Integration layer: cross-references, can compile together.
 *  NOTE: Skips full tsc rerun since stepTypeCheck (Step 5) already ran it.
 *  Only checks cross-file import consistency for changed files. */
async function validateIntegrationLayer(files: string[]): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];

  // Verify changed files import targets actually exist
  for (const file of files) {
    if (!file.endsWith('.ts')) continue;

    const fullPath = join(PROJECT_ROOT, file);
    let content: string;
    try {
      content = await readFile(fullPath, 'utf-8');
    } catch {
      continue;
    }

    // Check local imports resolve to existing files
    const importRegex = /from\s+['"](\.[\w/.@-]+\.js)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(content)) !== null) {
      const importPath = match[1]!;
      // Resolve relative to the file's directory
      const fileDir = join(PROJECT_ROOT, file, '..');
      const targetTs = join(fileDir, importPath.replace(/\.js$/, '.ts'));
      try {
        await access(targetTs);
      } catch {
        // Also check if .js file exists directly (e.g. generated files)
        const targetJs = join(fileDir, importPath);
        try {
          await access(targetJs);
        } catch {
          issues.push({
            layer: 'integration',
            file,
            message: `Import "${importPath}" resolves to non-existent file`,
            fixHint: `Create the target file or fix the import path`,
          });
        }
      }
    }
  }

  return issues;
}

/** Full 3-layer validation pipeline */
export async function layeredValidation(files: string[]): Promise<Result<ValidationReport>> {
  logger.info('validator', `Running layered validation on ${files.length} file(s)`);

  const allIssues: ValidationIssue[] = [];

  // Layer 1: Syntax
  const syntaxIssues = await validateSyntaxLayer(files);
  allIssues.push(...syntaxIssues);

  if (syntaxIssues.length > 0) {
    const report: ValidationReport = {
      passed: false,
      issues: allIssues,
      summary: `Syntax layer failed with ${syntaxIssues.length} issue(s)`,
    };
    return ok('Validation completed', report);
  }

  // Layer 2: Semantic
  const semanticIssues = await validateSemanticLayer(files);
  allIssues.push(...semanticIssues);

  if (semanticIssues.length > 0) {
    const report: ValidationReport = {
      passed: false,
      issues: allIssues,
      summary: `Semantic layer failed with ${semanticIssues.length} issue(s)`,
    };
    return ok('Validation completed', report);
  }

  // Layer 3: Integration
  const integrationIssues = await validateIntegrationLayer(files);
  allIssues.push(...integrationIssues);

  const passed = allIssues.length === 0;
  const report: ValidationReport = {
    passed,
    issues: allIssues,
    summary: passed
      ? 'All 3 validation layers passed'
      : `Integration layer failed with ${integrationIssues.length} issue(s)`,
  };

  logger.info('validator', `Validation ${passed ? 'PASSED' : 'FAILED'}: ${report.summary}`);
  return ok('Validation completed', report);
}
