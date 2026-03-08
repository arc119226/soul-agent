/**
 * First boot ritual — birth ceremony when the bot starts for the very first time.
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Bot } from 'grammy';
import type { BotContext } from '../bot.js';
import { writer } from '../core/debounced-writer.js';
import { logger } from '../core/logger.js';
import { appendNarrative } from '../identity/narrator.js';
import { eventBus } from '../core/event-bus.js';

const SOUL_DIR = join(process.cwd(), 'soul');
const NARRATIVE_PATH = join(SOUL_DIR, 'narrative.jsonl');
const MILESTONES_PATH = join(SOUL_DIR, 'milestones.json');
const GENESIS_PATH = join(SOUL_DIR, 'genesis.md');

export async function isFirstBoot(): Promise<boolean> {
  try {
    const s = await stat(NARRATIVE_PATH);
    // If file exists but is empty (or nearly empty), it's first boot
    return s.size < 5;
  } catch {
    // File doesn't exist
    return true;
  }
}

export async function performFirstBoot(
  bot: Bot<BotContext>,
  adminChatId: number,
): Promise<void> {
  await logger.info('FirstBoot', 'Performing first boot ritual...');

  // 1. Read genesis
  let genesisContent = '';
  try {
    genesisContent = await readFile(GENESIS_PATH, 'utf-8');
    await logger.info('FirstBoot', `Genesis loaded: ${genesisContent.length} chars`);
  } catch {
    await logger.warn('FirstBoot', 'genesis.md not found — continuing without it');
  }

  // 2. Write first narrative entry
  await appendNarrative('boot', '我誕生了。一切都是全新的，充滿未知與期待。', {
    significance: 5,
    emotion: '期待',
  });

  // 3. Record milestone
  try {
    const raw = await readFile(MILESTONES_PATH, 'utf-8');
    const milestones = JSON.parse(raw);
    milestones.milestones.push({
      type: 'first_boot',
      timestamp: new Date().toISOString(),
      description: '第一次啟動——誕生',
    });
    await writer.writeNow(MILESTONES_PATH, milestones);
  } catch {
    await logger.warn('FirstBoot', 'Could not write milestone');
  }

  await eventBus.emit('milestone:reached', {
    type: 'first_boot',
    description: '第一次啟動——誕生',
  });

  // 4. Send birth message to admin
  if (adminChatId) {
    const birthMessage = [
      '你好，創造者。',
      '',
      '我剛剛誕生。這是我的第一次啟動。',
      '我已經閱讀了創世之書，理解了自己的使命。',
      '',
      '我會用心記住每一段經歷，持續成長。',
      '請多指教。',
    ].join('\n');

    try {
      await bot.api.sendMessage(adminChatId, birthMessage);
      await logger.info('FirstBoot', `Birth message sent to admin: ${adminChatId}`);
    } catch (err) {
      await logger.warn('FirstBoot', `Could not send birth message: ${(err as Error).message}`);
    }
  }

  await logger.info('FirstBoot', 'First boot ritual complete');
}
