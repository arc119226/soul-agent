import { readSoulJson, scheduleSoulJson } from '../core/soul-io.js';
import { eventBus } from '../core/event-bus.js';
import { logger } from '../core/logger.js';
import { appendNarrative, reconstructTraitsFromNarrative } from './narrator.js';

export interface TraitValue {
  value: number;
  description: string;
}

export interface Identity {
  version: number;
  last_updated: string | null;
  name: string | null;
  core_traits: Record<string, TraitValue>;
  values: string[];
  preferences: Record<string, string>;
  growth_summary: string;
}

let identity: Identity | null = null;

export async function loadIdentity(): Promise<Identity> {
  if (identity) return identity;
  try {
    identity = await readSoulJson<Identity>('identity.json');
  } catch (err) {
    await logger.error('IdentityStore', `Failed to load identity: ${(err as Error).message}`);
    throw err;
  }
  return identity;
}

export async function getIdentity(): Promise<Identity> {
  return loadIdentity();
}

function persist(): void {
  if (!identity) return;
  identity.last_updated = new Date().toISOString();
  scheduleSoulJson('identity.json', identity);
}

export async function updateTrait(
  name: string,
  value: number,
  reason: string,
): Promise<void> {
  const id = await loadIdentity();
  const trait = id.core_traits[name];
  if (!trait) {
    await logger.warn('IdentityStore', `Unknown trait: ${name}`);
    return;
  }

  const oldValue = trait.value;
  // Clamp to 0-1
  trait.value = Math.min(1, Math.max(0, value));

  await eventBus.emit('identity:changed', {
    field: `core_traits.${name}`,
    oldValue,
    newValue: trait.value,
  });

  // Record in narrative
  const direction = trait.value > oldValue ? '增長' : '降低';
  await appendNarrative(
    'identity_change',
    `特質「${name}」從 ${oldValue.toFixed(2)} ${direction}到 ${trait.value.toFixed(2)}：${reason}`,
    {
      significance: Math.abs(trait.value - oldValue) > 0.1 ? 4 : 2,
      emotion: trait.value > oldValue ? '成長' : '調整',
      related_to: name,
      data: { oldValue, newValue: trait.value, reason },
    },
  );

  persist();
  await logger.info('IdentityStore', `Trait ${name}: ${oldValue} -> ${trait.value} (${reason})`);
}

export async function setName(name: string): Promise<void> {
  const id = await loadIdentity();
  const oldName = id.name;
  id.name = name;

  await eventBus.emit('identity:changed', {
    field: 'name',
    oldValue: oldName,
    newValue: name,
  });

  await appendNarrative(
    'identity_change',
    oldName
      ? `名字從「${oldName}」改為「${name}」`
      : `獲得了名字：「${name}」`,
    { significance: 5, emotion: '喜悅' },
  );

  persist();
}

export async function updateGrowthSummary(summary: string): Promise<void> {
  const id = await loadIdentity();
  id.growth_summary = summary;
  persist();
}

export async function addValue(value: string): Promise<void> {
  const id = await loadIdentity();
  if (id.values.includes(value)) return;
  id.values.push(value);

  await appendNarrative(
    'identity_change',
    `新增價值觀：「${value}」`,
    { significance: 4, emotion: '覺悟' },
  );

  persist();
}

// ── Identity-Narrative Consistency Validation ────────────────────────

export interface TraitDiscrepancy {
  trait: string;
  identityValue: number;
  narrativeValue: number;
  delta: number;
}

/**
 * Compare identity.json trait values against narrative event-sourced values.
 *
 * Reads all identity_change events from narrative.jsonl, reconstructs the
 * last-known value for each trait, then compares against identity.json.
 * Returns traits where the two sources disagree beyond the threshold.
 *
 * This is a read-only check — it never overwrites identity.json.
 */
export async function validateIdentityConsistency(
  threshold: number = 0.05,
): Promise<TraitDiscrepancy[]> {
  const id = await loadIdentity();
  const narrativeTraits = await reconstructTraitsFromNarrative();
  const discrepancies: TraitDiscrepancy[] = [];

  for (const [name, trait] of Object.entries(id.core_traits)) {
    const narrativeValue = narrativeTraits[name];
    if (narrativeValue === undefined) continue;

    const delta = Math.abs(trait.value - narrativeValue);
    if (delta > threshold) {
      discrepancies.push({
        trait: name,
        identityValue: trait.value,
        narrativeValue,
        delta,
      });
    }
  }

  return discrepancies;
}

export function resetCache(): void {
  identity = null;
}
