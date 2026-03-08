import { join } from 'node:path';
import { readdir, access } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { logger } from '../core/logger.js';
import { eventBus } from '../core/event-bus.js';
import { compilePlugin, cleanOldCompilations, cleanupCacheDir, disposeAllContexts } from './compiler.js';
import { isValidPlugin, type Plugin } from './plugin-api.js';
import { pluginHealth } from './plugin-health.js';

const PLUGINS_DIR = join(process.cwd(), 'plugins');

/** Currently loaded plugins */
const loadedPlugins = new Map<string, Plugin>();

/**
 * Scan, compile, and load all plugins from the plugins/ directory.
 */
export async function loadAllPlugins(): Promise<void> {
  // Clear stale cache before rebuilding
  await cleanupCacheDir();

  try {
    await access(PLUGINS_DIR);
  } catch {
    await logger.info('plugin-loader', 'No plugins/ directory found, skipping plugin loading');
    return;
  }

  const files = await readdir(PLUGINS_DIR);
  const tsFiles = files.filter((f) => f.endsWith('.ts') && !f.startsWith('.'));

  await logger.info('plugin-loader', `Found ${tsFiles.length} plugin files`);

  for (const file of tsFiles) {
    await loadPlugin(join(PLUGINS_DIR, file));
  }
}

/**
 * Load (or reload) a single plugin by source path.
 */
export async function loadPlugin(sourcePath: string): Promise<boolean> {
  const name = sourcePath.split('/').pop()?.replace('.ts', '') ?? 'unknown';

  try {
    // Dispose old version if exists
    const existing = loadedPlugins.get(name);
    if (existing?.dispose) {
      await existing.dispose();
    }

    // Compile TS → JS
    const compiledPath = await compilePlugin(sourcePath);

    // Import with cache-busting URL
    const moduleUrl = pathToFileURL(compiledPath).href;
    const mod = await import(moduleUrl);

    // Validate plugin structure
    const plugin: Plugin = mod.default ?? mod;
    if (!isValidPlugin(plugin)) {
      await logger.error('plugin-loader', `Invalid plugin structure: ${name}`);
      return false;
    }

    // Initialize if needed
    if (plugin.init) {
      await plugin.init();
    }

    // Register
    loadedPlugins.set(name, plugin);

    // Clean up old compilations
    await cleanOldCompilations(name, compiledPath);

    await eventBus.emit('plugin:loaded', { name });
    await logger.info('plugin-loader', `Loaded plugin: ${name} (${plugin.meta.description})`);

    return true;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await logger.error('plugin-loader', `Failed to load plugin: ${name}`, err);
    await eventBus.emit('plugin:error', { name, error: errorMsg });
    pluginHealth.recordError(name);
    return false;
  }
}

/**
 * Reload a specific plugin by name.
 */
export async function reloadPlugin(name: string): Promise<boolean> {
  const sourcePath = join(PLUGINS_DIR, `${name}.ts`);
  try {
    await access(sourcePath);
  } catch {
    await logger.error('plugin-loader', `Plugin source not found: ${sourcePath}`);
    return false;
  }

  const result = await loadPlugin(sourcePath);
  if (result) {
    await eventBus.emit('plugin:reloaded', { name });
  }
  return result;
}

/**
 * Reload all plugins.
 */
export async function reloadAllPlugins(): Promise<{ success: number; failed: number }> {
  // Dispose all
  for (const [, plugin] of loadedPlugins) {
    if (plugin.dispose) {
      try {
        await plugin.dispose();
      } catch {
        // Best effort disposal
      }
    }
  }
  loadedPlugins.clear();
  await disposeAllContexts(); // Clean slate for full reload

  let success = 0;
  let failed = 0;

  const files = await readdir(PLUGINS_DIR).catch(() => [] as string[]);
  const tsFiles = files.filter((f) => f.endsWith('.ts') && !f.startsWith('.'));

  for (const file of tsFiles) {
    const ok = await loadPlugin(join(PLUGINS_DIR, file));
    if (ok) success++;
    else failed++;
  }

  return { success, failed };
}

/** Get all loaded plugins */
export function getLoadedPlugins(): Map<string, Plugin> {
  return loadedPlugins;
}

/** Get a specific plugin by name */
export function getPlugin(name: string): Plugin | undefined {
  return loadedPlugins.get(name);
}

/** Dispose all plugins (for shutdown) */
export async function disposeAllPlugins(): Promise<void> {
  for (const [name, plugin] of loadedPlugins) {
    if (plugin.dispose) {
      try {
        await plugin.dispose();
      } catch (err) {
        await logger.error('plugin-loader', `Error disposing plugin: ${name}`, err);
      }
    }
  }
  loadedPlugins.clear();
  await disposeAllContexts(); // Free esbuild contexts on shutdown
}
