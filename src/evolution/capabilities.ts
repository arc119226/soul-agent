/**
 * Self-capability model — tracks what the bot can and cannot do.
 * Persists to soul/evolution/capabilities.json.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writer } from '../core/debounced-writer.js';
import { logger } from '../core/logger.js';
import { ok, fail, type Result } from '../result.js';

const CAPS_FILE = join(process.cwd(), 'soul', 'evolution', 'capabilities.json');

interface CapabilitiesFile {
  version: number;
  last_updated: string | null;
  core_capabilities: string[];
  plugin_capabilities: string[];
  limitations: string[];
}

let capsCache: CapabilitiesFile = {
  version: 1,
  last_updated: null,
  core_capabilities: [],
  plugin_capabilities: [],
  limitations: [],
};

/** Load capabilities from disk */
export async function loadCapabilities(): Promise<void> {
  try {
    const raw = await readFile(CAPS_FILE, 'utf-8');
    capsCache = JSON.parse(raw);
    logger.info('capabilities', `Loaded ${capsCache.core_capabilities.length} core + ${capsCache.plugin_capabilities.length} plugin capabilities`);
  } catch {
    logger.info('capabilities', 'No existing capabilities file, starting fresh');
  }
}

function saveCaps(): void {
  capsCache.last_updated = new Date().toISOString();
  writer.schedule(CAPS_FILE, capsCache);
}

/** Add a core capability */
export function addCapability(description: string): Result {
  if (capsCache.core_capabilities.includes(description)) {
    return fail('Capability already exists');
  }
  capsCache.core_capabilities.push(description);
  saveCaps();
  logger.info('capabilities', `Added capability: ${description}`);
  return ok('Capability added');
}

/** Add a plugin capability */
export function addPluginCapability(description: string): Result {
  if (capsCache.plugin_capabilities.includes(description)) {
    return fail('Plugin capability already exists');
  }
  capsCache.plugin_capabilities.push(description);
  saveCaps();
  logger.info('capabilities', `Added plugin capability: ${description}`);
  return ok('Plugin capability added');
}

/** Remove a capability (core or plugin) */
export function removeCapability(description: string): Result {
  let idx = capsCache.core_capabilities.indexOf(description);
  if (idx !== -1) {
    capsCache.core_capabilities.splice(idx, 1);
    saveCaps();
    logger.info('capabilities', `Removed core capability: ${description}`);
    return ok('Capability removed');
  }
  idx = capsCache.plugin_capabilities.indexOf(description);
  if (idx !== -1) {
    capsCache.plugin_capabilities.splice(idx, 1);
    saveCaps();
    logger.info('capabilities', `Removed plugin capability: ${description}`);
    return ok('Capability removed');
  }
  return fail('Capability not found');
}

/** Add a known limitation */
export function addLimitation(description: string): Result {
  if (capsCache.limitations.includes(description)) {
    return fail('Limitation already exists');
  }
  capsCache.limitations.push(description);
  saveCaps();
  return ok('Limitation added');
}

/** Remove a limitation */
export function removeLimitation(description: string): Result {
  const idx = capsCache.limitations.indexOf(description);
  if (idx === -1) return fail('Limitation not found');
  capsCache.limitations.splice(idx, 1);
  saveCaps();
  return ok('Limitation removed');
}

/** Get a formatted description of all capabilities */
export function getCapabilities(): string {
  const sections: string[] = [];

  if (capsCache.core_capabilities.length > 0) {
    sections.push('## Core Capabilities');
    for (const cap of capsCache.core_capabilities) {
      sections.push(`- ${cap}`);
    }
  }

  if (capsCache.plugin_capabilities.length > 0) {
    sections.push('## Plugin Capabilities');
    for (const cap of capsCache.plugin_capabilities) {
      sections.push(`- ${cap}`);
    }
  }

  if (capsCache.limitations.length > 0) {
    sections.push('## Known Limitations');
    for (const lim of capsCache.limitations) {
      sections.push(`- ${lim}`);
    }
  }

  return sections.join('\n');
}

/** Get raw capabilities data */
export function getCapabilitiesData(): CapabilitiesFile {
  return { ...capsCache };
}
