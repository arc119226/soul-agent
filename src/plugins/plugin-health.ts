import { logger } from '../core/logger.js';

interface HealthEntry {
  errorCount: number;
  lastError: number;
  disabled: boolean;
  disabledAt?: number;
}

const ERROR_THRESHOLD = 5; // Auto-disable after 5 errors
const RESET_INTERVAL = 60 * 60 * 1000; // 1 hour

/**
 * Plugin health monitoring.
 * Tracks error rates and auto-disables problematic plugins.
 */
class PluginHealth {
  private entries = new Map<string, HealthEntry>();

  recordError(name: string): void {
    const entry = this.getOrCreate(name);
    entry.errorCount++;
    entry.lastError = Date.now();

    if (entry.errorCount >= ERROR_THRESHOLD && !entry.disabled) {
      entry.disabled = true;
      entry.disabledAt = Date.now();
      logger.warn('plugin-health', `Plugin ${name} auto-disabled after ${entry.errorCount} errors`);
    }
  }

  recordSuccess(name: string): void {
    const entry = this.getOrCreate(name);
    // Reduce error count on success
    if (entry.errorCount > 0) {
      entry.errorCount = Math.max(0, entry.errorCount - 1);
    }
  }

  isDisabled(name: string): boolean {
    const entry = this.entries.get(name);
    if (!entry) return false;
    if (!entry.disabled) return false;

    // Auto-re-enable after reset interval
    if (entry.disabledAt && Date.now() - entry.disabledAt > RESET_INTERVAL) {
      entry.disabled = false;
      entry.errorCount = 0;
      logger.info('plugin-health', `Plugin ${name} re-enabled after cooldown`);
      return false;
    }

    return true;
  }

  enable(name: string): void {
    const entry = this.entries.get(name);
    if (entry) {
      entry.disabled = false;
      entry.errorCount = 0;
    }
  }

  getStatus(name: string): HealthEntry | undefined {
    return this.entries.get(name);
  }

  getAllStatus(): Map<string, HealthEntry> {
    return new Map(this.entries);
  }

  private getOrCreate(name: string): HealthEntry {
    let entry = this.entries.get(name);
    if (!entry) {
      entry = { errorCount: 0, lastError: 0, disabled: false };
      this.entries.set(name, entry);
    }
    return entry;
  }
}

export const pluginHealth = new PluginHealth();
