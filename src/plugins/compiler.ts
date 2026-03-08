import { context, type BuildContext } from 'esbuild';
import { join, basename } from 'node:path';
import { mkdir, writeFile, readdir, unlink as unlinkFile } from 'node:fs/promises';
import { logger } from '../core/logger.js';

const CACHE_DIR = join(process.cwd(), '.plugin-cache');

/** Persistent esbuild contexts, keyed by plugin source path */
const contexts = new Map<string, BuildContext>();

/**
 * Compile a single TypeScript plugin file to ESM JavaScript.
 * Uses esbuild Context API for faster rebuilds — the first call creates a
 * persistent context, subsequent calls reuse it via ctx.rebuild().
 * Returns the path to the compiled .mjs file with cache-busting timestamp.
 */
export async function compilePlugin(sourcePath: string): Promise<string> {
  await mkdir(CACHE_DIR, { recursive: true });

  const name = basename(sourcePath, '.ts');
  const timestamp = Date.now();
  const outFile = join(CACHE_DIR, `${name}.${timestamp}.mjs`);

  try {
    let ctx = contexts.get(sourcePath);
    if (!ctx) {
      ctx = await context({
        entryPoints: [sourcePath],
        bundle: false, // Don't bundle — let Node resolve imports
        format: 'esm',
        platform: 'node',
        target: 'node20',
        sourcemap: false,
        logLevel: 'silent',
        write: false,         // Return output in memory instead of writing to disk
        outdir: CACHE_DIR,    // Required for esbuild to determine output structure
        metafile: true,       // Future-proofing for dependency tracking
      });
      contexts.set(sourcePath, ctx);
    }

    const result = await ctx.rebuild();

    const firstOutput = result.outputFiles?.[0];
    if (!firstOutput) {
      throw new Error(`esbuild produced no output for ${name}`);
    }

    // Write to timestamped path for ESM cache busting
    await writeFile(outFile, firstOutput.contents);

    await logger.debug('compiler', `Compiled plugin: ${name} → ${outFile}`);
    return outFile;
  } catch (err) {
    // BuildFailure (syntax errors) — context remains valid for next rebuild.
    // Other errors — dispose context so next call creates a fresh one.
    if (err && typeof err === 'object' && 'errors' in err) {
      await logger.error('compiler', `Build failed for plugin: ${name}`, err);
    } else {
      await disposeContext(sourcePath);
      await logger.error('compiler', `Context error for plugin: ${name}`, err);
    }
    throw err;
  }
}

/** Dispose a single plugin's esbuild context */
async function disposeContext(sourcePath: string): Promise<void> {
  const ctx = contexts.get(sourcePath);
  if (ctx) {
    try {
      await ctx.dispose();
    } catch {
      // Best effort disposal
    }
    contexts.delete(sourcePath);
  }
}

/** Dispose all esbuild contexts (for shutdown or full reload) */
export async function disposeAllContexts(): Promise<void> {
  for (const [, ctx] of contexts) {
    try {
      await ctx.dispose();
    } catch {
      // Best effort
    }
  }
  contexts.clear();
}

/** Remove a specific plugin's esbuild context */
export async function removePluginContext(sourcePath: string): Promise<void> {
  await disposeContext(sourcePath);
}

/**
 * Clean up all stale .mjs files in the plugin cache directory.
 * Called at startup before loadAllPlugins() rebuilds the cache.
 */
export async function cleanupCacheDir(): Promise<void> {
  try {
    const files = await readdir(CACHE_DIR);
    let deleted = 0;
    for (const file of files) {
      if (file.endsWith('.mjs')) {
        await unlinkFile(join(CACHE_DIR, file)).catch(() => {});
        deleted++;
      }
    }
    if (deleted > 0) {
      await logger.debug('compiler', `Startup: cleared plugin cache (${deleted} files)`);
    }
  } catch {
    // Cache dir might not exist yet — silent
  }
}

/**
 * Clean up old compiled plugin files for a given plugin name.
 */
export async function cleanOldCompilations(pluginName: string, keepPath?: string): Promise<void> {
  try {
    const { readdir, unlink } = await import('node:fs/promises');
    const files = await readdir(CACHE_DIR);
    const prefix = `${pluginName}.`;

    for (const file of files) {
      if (file.startsWith(prefix) && file.endsWith('.mjs')) {
        const fullPath = join(CACHE_DIR, file);
        if (fullPath !== keepPath) {
          await unlink(fullPath).catch(() => {});
        }
      }
    }
  } catch {
    // Cache dir might not exist yet
  }
}
