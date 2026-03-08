import { readSoulJson, scheduleSoulJson } from '../core/soul-io.js';
import { eventBus } from '../core/event-bus.js';
import { logger } from '../core/logger.js';

/* ── defaults & thresholds ────────────────────── */
const DEFAULT_ENERGY = 1.0;
const DEFAULT_CONFIDENCE = 0.4;
const LOW_ENERGY_THRESHOLD = 0.3;
const RECOVERY_ENERGY = 0.7;
const SIGNIFICANT_CHANGE = 0.1;

export interface VitalsData {
  version: number;
  last_updated: string | null;
  energy_level: number;    // 0-1
  confidence_level: number; // 0-1
  curiosity_focus: string;
  mood: string;
  mood_reason: string;
  /** SHA-256 composite hash of critical soul files (set by soul-integrity module) */
  identity_fingerprint?: string;
  /** Per-file SHA-256 hashes for precise change detection */
  identity_file_hashes?: Record<string, string>;
  /** Last identity health check result (4-layer facade) */
  identity_health_status?: 'healthy' | 'degraded' | 'compromised';
  identity_health_checked_at?: string;
}

let vitals: VitalsData | null = null;

async function load(): Promise<VitalsData> {
  if (vitals) return vitals;
  try {
    vitals = await readSoulJson<VitalsData>('vitals.json');
  } catch {
    vitals = {
      version: 1,
      last_updated: null,
      energy_level: DEFAULT_ENERGY,
      confidence_level: DEFAULT_CONFIDENCE,
      curiosity_focus: '',
      mood: '平靜',
      mood_reason: '',
    };
  }
  return vitals;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function persist(): void {
  if (!vitals) return;
  vitals.last_updated = new Date().toISOString();
  scheduleSoulJson('vitals.json', vitals);
}

export async function getVitals(): Promise<VitalsData> {
  return load();
}

/**
 * Startup recovery check — simulate offline sleep if bot was down for a long time.
 * - < 5 min since last_updated → keep as-is (molt/restart)
 * - > 6 hours and energy < 0.3 → set to 0.7 (offline sleep recovery)
 * - otherwise → keep as-is
 */
export async function checkStartupRecovery(): Promise<void> {
  const v = await load();
  if (!v.last_updated) return;

  const elapsed = Date.now() - new Date(v.last_updated).getTime();
  const FIVE_MIN = 5 * 60 * 1000;
  const SIX_HOURS = 6 * 60 * 60 * 1000;

  if (elapsed < FIVE_MIN) {
    // Molt/restart — keep energy as-is
    return;
  }

  if (elapsed > SIX_HOURS && v.energy_level < LOW_ENERGY_THRESHOLD) {
    const oldEnergy = v.energy_level;
    v.energy_level = RECOVERY_ENERGY;
    persist();
    await logger.info('Vitals',
      `Startup recovery: energy ${oldEnergy.toFixed(2)} → 0.70 (offline for ${(elapsed / 3600000).toFixed(1)}h)`);
  }

  // Validate identity consistency against narrative event log
  try {
    const { validateIdentityConsistency } = await import('./identity-store.js');
    const discrepancies = await validateIdentityConsistency();
    if (discrepancies.length > 0) {
      const details = discrepancies
        .map(d => `${d.trait}(id=${d.identityValue.toFixed(2)},nar=${d.narrativeValue.toFixed(2)})`)
        .join(', ');
      await logger.warn('Vitals', `Identity-narrative discrepancy: ${details}`);

      try {
        const { appendAuditEntry } = await import('../safety/audit-chain.js');
        await appendAuditEntry('integrity:mismatch', {
          witnessNote: `Identity-narrative trait discrepancy at startup: ${details}`,
          filesChanged: ['soul/identity.json', 'soul/narrative.jsonl'],
        });
      } catch { /* audit is non-critical */ }
    }
  } catch { /* validation is best-effort */ }
}

export async function updateEnergy(delta: number): Promise<number> {
  const v = await load();
  const oldLevel = v.energy_level;
  v.energy_level = clamp(v.energy_level + delta);
  persist();

  // Emit event on significant change
  if (Math.abs(v.energy_level - oldLevel) >= SIGNIFICANT_CHANGE) {
    await eventBus.emit('identity:changed', {
      field: 'energy_level',
      oldValue: oldLevel,
      newValue: v.energy_level,
    });
    await logger.debug('Vitals', `Energy: ${oldLevel.toFixed(2)} -> ${v.energy_level.toFixed(2)}`);
  }

  return v.energy_level;
}

export async function updateConfidence(delta: number): Promise<number> {
  const v = await load();
  const oldLevel = v.confidence_level;
  v.confidence_level = clamp(v.confidence_level + delta);
  persist();

  if (Math.abs(v.confidence_level - oldLevel) >= SIGNIFICANT_CHANGE) {
    await eventBus.emit('identity:changed', {
      field: 'confidence_level',
      oldValue: oldLevel,
      newValue: v.confidence_level,
    });
    await logger.debug('Vitals', `Confidence: ${oldLevel.toFixed(2)} -> ${v.confidence_level.toFixed(2)}`);
  }

  return v.confidence_level;
}

export async function setMood(mood: string, reason: string): Promise<void> {
  const v = await load();
  const oldMood = v.mood;
  v.mood = mood;
  v.mood_reason = reason;
  persist();

  if (oldMood !== mood) {
    await eventBus.emit('identity:changed', {
      field: 'mood',
      oldValue: oldMood,
      newValue: mood,
    });
    await logger.debug('Vitals', `Mood: ${oldMood} -> ${mood} (${reason})`);
  }
}

export async function setCuriosityFocus(focus: string): Promise<void> {
  const v = await load();
  v.curiosity_focus = focus;
  persist();
}

export async function getFingerprint(): Promise<string | null> {
  const v = await load();
  return v.identity_fingerprint ?? null;
}

export async function setFingerprint(hash: string, fileHashes?: Record<string, string>): Promise<void> {
  const v = await load();
  v.identity_fingerprint = hash;
  if (fileHashes) {
    v.identity_file_hashes = fileHashes;
  }
  persist();
}

export async function getFileHashes(): Promise<Record<string, string> | null> {
  const v = await load();
  return v.identity_file_hashes ?? null;
}

export async function setHealthStatus(
  status: 'healthy' | 'degraded' | 'compromised',
): Promise<void> {
  const v = await load();
  v.identity_health_status = status;
  v.identity_health_checked_at = new Date().toISOString();
  persist();
}

export async function getHealthStatus(): Promise<{
  status: 'healthy' | 'degraded' | 'compromised' | undefined;
  checkedAt: string | undefined;
}> {
  const v = await load();
  return {
    status: v.identity_health_status,
    checkedAt: v.identity_health_checked_at,
  };
}

export function resetCache(): void {
  vitals = null;
}
