import type { BotContext } from '../bot.js';

/**
 * Plugin interface — the contract for dynamic plugins.
 */
export interface PluginMeta {
  name: string;
  description: string;
  icon?: string;
  aliases?: string[];
  version?: string;
}

export interface PluginContext {
  bot: BotContext;
  chatId: number;
  userId: number;
  sendMarkdown: (text: string) => Promise<void>;
  sendLongMessage: (text: string) => Promise<void>;
}

export interface Plugin {
  meta: PluginMeta;
  handler: (ctx: PluginContext, args: string) => Promise<void>;
  onCallback?: (ctx: PluginContext, data: string) => Promise<void>;
  dispose?: () => void | Promise<void>;
  init?: () => void | Promise<void>;
}

/** Type guard for plugin validation */
export function isValidPlugin(obj: unknown): obj is Plugin {
  if (!obj || typeof obj !== 'object') return false;
  const p = obj as Record<string, unknown>;
  if (!p.meta || typeof p.meta !== 'object') return false;
  const meta = p.meta as Record<string, unknown>;
  if (typeof meta.name !== 'string' || typeof meta.description !== 'string') return false;
  if (typeof p.handler !== 'function') return false;
  return true;
}
