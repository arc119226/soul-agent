/**
 * Bootstrap Phase 1 — Soul Loading
 *
 * Critical phase: verifies soul exists, initializes database,
 * loads identity/vitals, runs integrity checks, auth preflight.
 * Failures in core loading are fatal (process.exit).
 */

import { logger } from '../core/logger.js';
import { eventBus } from '../core/event-bus.js';

export interface SoulLoadResult {
  identityName: string;
  authReport: { cliAvailable: boolean; apiKeyPresent: boolean; summary: string } | null;
  firstBoot: boolean;
}

export async function loadSoul(): Promise<SoulLoadResult> {
  // Phase 1: Verify soul exists
  await logger.info('startup', 'Verifying soul...');
  try {
    const { access } = await import('node:fs/promises');
    await access('soul/genesis.md');
    await logger.info('startup', 'Soul verified — genesis.md found');
  } catch {
    await logger.error('startup', 'FATAL: soul/genesis.md not found. Bot cannot start without a soul.');
    process.exit(1);
  }

  // Phase 1.4: Initialize SQLite database
  try {
    const { getDb } = await import('../core/database.js');
    getDb();
    await logger.info('startup', 'SQLite database initialized');
  } catch (err) {
    await logger.error('startup', 'FATAL: SQLite database initialization failed', err);
    process.exit(1);
  }

  // Phase 1.5: Soul loading (must succeed)
  await logger.info('startup', 'Loading soul...');
  try {
    const { initMemoryDir } = await import('../memory/chat-memory.js');
    await initMemoryDir();
    await logger.info('startup', 'Memory directory initialized');
  } catch (err) {
    await logger.error('startup', 'FATAL: Failed to init memory directory', err);
    process.exit(1);
  }

  try {
    const { loadSessions } = await import('../claude/session-store.js');
    await loadSessions();
    await logger.info('startup', 'Sessions loaded');
  } catch (err) {
    await logger.error('startup', 'FATAL: Failed to load sessions', err);
    process.exit(1);
  }

  let identityName = '(unnamed)';
  try {
    const { loadIdentity, setName, getIdentity } = await import('../identity/identity-store.js');
    const identity = await loadIdentity();

    // Name sync: if identity.name is null, check user memory for assigned name
    if (!identity.name) {
      try {
        const { readFile } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const memDir = join(process.cwd(), 'soul', 'memory');
        const { readdir } = await import('node:fs/promises');
        const files = await readdir(memDir);
        for (const file of files) {
          if (!file.endsWith('_memory.json')) continue;
          const raw = await readFile(join(memDir, file), 'utf-8');
          const mem = JSON.parse(raw);
          // Search facts and decisions for name assignment
          const allText = [
            ...(mem.topics || []).map((t: { topic: string }) => t.topic),
            ...(mem.decisions || []).map((d: { decision: string }) => d.decision),
            ...(mem.events || []).map((e: { event: string }) => e.event),
          ].join(' ');
          const nameMatch = allText.match(/(?:名字|取名|叫做|命名)[：:「]?\s*([^\s」,，。]+)/);
          if (nameMatch?.[1]) {
            await setName(nameMatch[1]);
            await logger.info('startup', `Name synced from memory: ${nameMatch[1]}`);
            break;
          }
        }
      } catch {
        // Name sync is non-critical
      }
    }

    const id = await getIdentity();
    identityName = id.name || '(unnamed)';
    await logger.info('startup', `Soul loaded — identity: ${identityName}`);
  } catch (err) {
    await logger.error('startup', 'FATAL: Failed to load identity', err);
    process.exit(1);
  }

  try {
    const { getVitals, checkStartupRecovery } = await import('../identity/vitals.js');
    await checkStartupRecovery();
    const vitals = await getVitals();
    await logger.info('startup', `Vitals loaded — energy: ${(vitals.energy_level * 100).toFixed(0)}%, mood: ${vitals.mood}`);
  } catch (err) {
    await logger.error('startup', 'FATAL: Failed to load vitals', err);
    process.exit(1);
  }

  // Phase 1.6: Soul integrity verification (non-critical from here)
  try {
    const { verifySoulIntegrity, computeSoulFingerprint } = await import('../safety/soul-integrity.js');
    const { getFingerprint, setFingerprint, getFileHashes } = await import('../identity/vitals.js');

    const storedHash = await getFingerprint();
    const storedFileHashes = await getFileHashes();
    const report = await verifySoulIntegrity(storedHash, storedFileHashes);

    if (report.ok) {
      if (!report.value.valid) {
        await logger.warn('startup',
          `Soul integrity mismatch! Changed: [${report.value.changedFiles.join(', ')}]`,
        );
        await eventBus.emit('soul:integrity_mismatch', {
          changedFiles: report.value.changedFiles,
          expected: report.value.expected!,
          actual: report.value.actual,
        });
      }

      // Initialize or update fingerprint to current state
      const fp = await computeSoulFingerprint();
      if (fp.ok) {
        if (storedHash === null) {
          await logger.info('startup', `Soul fingerprint initialized: ${fp.value.hash.slice(0, 12)}...`);
        } else if (report.value.valid) {
          await logger.info('startup', 'Soul integrity verified — fingerprint matches');
        }
        await setFingerprint(fp.value.hash, fp.value.files);
      }
    }
  } catch (err) {
    await logger.warn('startup', 'Soul integrity check failed (non-fatal)', err);
  }

  // Phase 1.6a: Initialize audit chain early
  try {
    const { initAuditChain } = await import('../safety/audit-chain.js');
    await initAuditChain();
  } catch (err) {
    await logger.warn('startup', 'Audit chain init failed (non-fatal)', err);
  }

  // Phase 1.6b: Full identity health check (4-layer facade)
  try {
    const { runFullIdentityCheck } = await import('../identity/identity-continuity.js');
    const { setHealthStatus, setFingerprint: setFp } = await import('../identity/vitals.js');

    const healthReport = await runFullIdentityCheck();
    await setHealthStatus(healthReport.status);

    // Refresh fingerprint after health check
    try {
      const { computeSoulFingerprint } = await import('../safety/soul-integrity.js');
      const fp = await computeSoulFingerprint();
      if (fp.ok) await setFp(fp.value.hash, fp.value.files);
    } catch { /* fingerprint refresh is non-critical */ }

    if (healthReport.status === 'healthy') {
      await logger.info('startup', `Identity health: ${healthReport.status} — ${healthReport.summary}`);
    } else if (healthReport.status === 'degraded') {
      await logger.warn('startup', `Identity health: ${healthReport.status} — ${healthReport.summary}`);
      try {
        const { appendNarrative } = await import('../identity/narrator.js');
        await appendNarrative('reflection', `啟動時身份驗證異常：${healthReport.summary}`, {
          significance: 3,
          related_to: 'identity-health',
        });
      } catch { /* narrative is non-critical */ }
    } else {
      await logger.error('startup', `Identity health: ${healthReport.status} — ${healthReport.summary}`);
      await eventBus.emit('soul:integrity_mismatch', {
        changedFiles: healthReport.layers.filter(l => l.status === 'fail').map(l => l.layer),
        expected: 'healthy',
        actual: healthReport.status,
      });
      try {
        const { appendNarrative } = await import('../identity/narrator.js');
        await appendNarrative('reflection', `啟動時身份驗證嚴重異常：${healthReport.summary}`, {
          significance: 5,
          emotion: '警覺',
          related_to: 'identity-health',
        });
      } catch { /* narrative is non-critical */ }
    }

    await eventBus.emit('identity:health_check', {
      status: healthReport.status,
      summary: healthReport.summary,
      context: 'startup',
    });
  } catch (err) {
    await logger.warn('startup', 'Full identity health check failed (non-fatal)', err);
  }

  // Phase 1.7: Claude authentication preflight
  let authReport: SoulLoadResult['authReport'] = null;
  try {
    const { checkClaudeAuth } = await import('../claude/preflight.js');
    authReport = await checkClaudeAuth();
    if (!authReport.cliAvailable) {
      await logger.error('startup', 'Claude CLI not available — all Claude calls will fail until installed');
    }
  } catch (err) {
    await logger.warn('startup', 'Auth preflight check failed (non-fatal)', err);
  }

  let firstBoot = false;
  try {
    const { isFirstBoot } = await import('../lifecycle/first-boot.js');
    firstBoot = await isFirstBoot();
    if (firstBoot) {
      await logger.info('startup', 'First boot detected — will perform birth ritual');
    }
  } catch (err) {
    await logger.warn('startup', 'Could not check first boot status', err);
  }

  return { identityName, authReport, firstBoot };
}
