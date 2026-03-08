import type { Bot } from 'grammy';
import type { BotContext } from '../bot.js';
import { logger } from '../core/logger.js';
import { formatUserError } from './helpers.js';

export type CommandHandler = (ctx: BotContext) => Promise<void> | void;
export type CallbackHandler = (ctx: BotContext, data: string) => Promise<void> | void;

interface CommandEntry {
  name: string;
  description: string;
  handler: CommandHandler;
  aliases: string[];
  adminOnly: boolean;
}

export interface IntentMatch {
  command: CommandEntry;
  confidence: number; // 0-1
}

// ── Natural language intent patterns ────────────────────────────────
// Each pattern maps a regex to a command name.
// Patterns are tested in order; first match wins.
// These cover common ways users might phrase a request in Chinese/English.

interface IntentPattern {
  pattern: RegExp;
  command: string;
  confidence: number;
}

const INTENT_PATTERNS: IntentPattern[] = [
  // --- sys (重啟/關機/休眠 → 顯示系統面板) ---
  { pattern: /^(?:幫我|幫忙)?(?:重啟|重開|restart|reboot)(?:一下)?(?:吧|呢)?[!！。?？]*$/i, command: 'sys', confidence: 0.95 },
  { pattern: /^(?:幫我|幫忙)?(?:關機|關閉|shutdown|停止運行)(?:吧|呢)?[!！。?？]*$/i, command: 'sys', confidence: 0.95 },
  { pattern: /^(?:去)?(?:睡覺|休息|休眠|dormant)(?:吧|呢)?[!！。?？]*$/i, command: 'sys', confidence: 0.95 },

  // --- status ---
  { pattern: /^(?:你(?:的|目前)?)?(?:狀態|狀況)(?:如何|怎[麼樣]|呢)?[?？!！。]*$/i, command: 'status', confidence: 0.9 },
  { pattern: /^(?:bot|機器人)(?:的)?(?:狀態|狀況)[?？!！。]*$/i, command: 'status', confidence: 0.9 },

  // --- help ---
  { pattern: /^(?:你)?(?:能做什麼|會什麼|有什麼功能|可以幹嘛|能幹嘛)[?？!！。]*$/i, command: 'help', confidence: 0.9 },

  // --- menu (指令列表) ---
  { pattern: /^(?:有什麼|有哪些|列出|顯示)?(?:全部|所有)?(?:指令|命令|功能)(?:列表|清單)?[?？!！。]*$/i, command: 'menu', confidence: 0.95 },

  // --- evolve ---
  { pattern: /^(?:幫我|幫忙)?(?:進化|升級|自我改進|evolve)(?:吧|呢)?[!！。?？]*$/i, command: 'evolve', confidence: 0.9 },
];

/**
 * Unified command registry with intent matching.
 */
class CommandRegistry {
  private commands = new Map<string, CommandEntry>();
  private callbacks = new Map<string, CallbackHandler>();
  private aliasMap = new Map<string, string>(); // alias → command name

  /** Register a text command */
  registerCommand(entry: {
    name: string;
    description: string;
    handler: CommandHandler;
    aliases?: string[];
    adminOnly?: boolean;
  }): void {
    const full: CommandEntry = {
      ...entry,
      aliases: entry.aliases ?? [],
      adminOnly: entry.adminOnly ?? false,
    };
    this.commands.set(entry.name, full);

    // Register aliases for intent matching
    for (const alias of full.aliases) {
      this.aliasMap.set(alias.toLowerCase(), entry.name);
    }
  }

  /** Register a callback query handler */
  registerCallback(prefix: string, handler: CallbackHandler): void {
    this.callbacks.set(prefix, handler);
  }

  /**
   * Match text against command aliases (exact keyword match).
   * Used as the first pass — fast and precise.
   */
  matchAlias(text: string): CommandEntry | null {
    const lower = text.toLowerCase().trim();

    // Sort aliases by length (longest first) for best match
    const sortedAliases = [...this.aliasMap.entries()].sort(
      (a, b) => b[0].length - a[0].length
    );

    for (const [alias, cmdName] of sortedAliases) {
      if (lower.includes(alias)) {
        return this.commands.get(cmdName) ?? null;
      }
    }

    return null;
  }

  /**
   * Match natural language text against intent patterns (regex only).
   * Alias matching is intentionally excluded here — aliases are too
   * broad (substring includes) and hijack normal conversation.
   * Aliases are still used for /command routing in plugin-router.
   */
  matchIntent(text: string): IntentMatch | null {
    const lower = text.toLowerCase().trim();

    // Only match short, command-like messages.
    // Increased from 20 to 30 to allow slightly longer commands like "好 進行commit"
    // to pass through to Claude Code for semantic understanding.
    if (lower.length > 30) return null;

    for (const { pattern, command, confidence } of INTENT_PATTERNS) {
      if (pattern.test(lower)) {
        const entry = this.commands.get(command);
        if (entry) {
          return { command: entry, confidence };
        }
      }
    }

    return null;
  }

  /** Bind all commands to a grammY Bot instance */
  bindToBot(bot: Bot<BotContext>): void {
    for (const [name, entry] of this.commands) {
      bot.command(name, async (ctx) => {
        if (entry.adminOnly) {
          const { config } = await import('../config.js');
          if (ctx.from?.id !== config.ADMIN_USER_ID) {
            return;
          }
        }
        try {
          await entry.handler(ctx);
        } catch (err) {
          logger.error('command', `Error in /${name}`, err);
          await ctx.reply(formatUserError('cli-error', '指令執行失敗'));
        }
      });
    }

    // Callback query routing
    bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      await this.routeCallback(ctx, data);
    });
  }

  /** Route a callback query to the appropriate handler */
  async routeCallback(ctx: BotContext, data: string): Promise<void> {
    // Find matching prefix (longest match first)
    const prefixes = [...this.callbacks.keys()].sort(
      (a, b) => b.length - a.length
    );

    for (const prefix of prefixes) {
      if (data.startsWith(prefix)) {
        const suffix = data.slice(prefix.length);
        try {
          await this.callbacks.get(prefix)!(ctx, suffix.startsWith(':') ? suffix.slice(1) : suffix);
          await ctx.answerCallbackQuery();
        } catch (err) {
          logger.error('callback', `Error in callback ${prefix}`, err);
          await ctx.answerCallbackQuery({ text: formatUserError('cli-error', '指令執行失敗', { compact: true }) });
        }
        return;
      }
    }

    await ctx.answerCallbackQuery({ text: '未知操作' });
  }

  /** Get command list for /help and BotFather */
  getCommandList(): { command: string; description: string }[] {
    return [...this.commands.values()].map((c) => ({
      command: c.name,
      description: c.description,
    }));
  }

  /** Get a command by name */
  getCommand(name: string): CommandEntry | undefined {
    return this.commands.get(name);
  }
}

export const commandRegistry = new CommandRegistry();

// ── Parent + Subcommand helper ──────────────────────────────────────

export interface SubcommandDef {
  name: string;
  aliases?: string[];
  description: string;
  handler: CommandHandler;
}

/**
 * Register a parent command with subcommands.
 * `/parent sub arg1 arg2` → finds matching subcommand → executes handler.
 * `/parent` (no args) → executes defaultHandler (usually shows sub-menu).
 * Unknown subcommand → shows available subcommands.
 */
export function registerParentCommand(opts: {
  name: string;
  description: string;
  aliases?: string[];
  adminOnly?: boolean;
  subcommands: SubcommandDef[];
  defaultHandler?: CommandHandler;
}): void {
  const subMap = new Map<string, SubcommandDef>();
  for (const sub of opts.subcommands) {
    subMap.set(sub.name, sub);
    for (const alias of sub.aliases ?? []) {
      subMap.set(alias, sub);
    }
  }

  commandRegistry.registerCommand({
    name: opts.name,
    description: opts.description,
    aliases: opts.aliases,
    adminOnly: opts.adminOnly,
    handler: async (ctx) => {
      const text = ctx.message?.text ?? '';
      // In callback context, text is the button's parent message — not a /command.
      // Detect and fall through to defaultHandler.
      const isSlash = text.startsWith('/');
      const afterCmd = isSlash
        ? text.replace(new RegExp(`^\\/${opts.name}\\s*`, 'i'), '').trim()
        : '';

      if (!afterCmd) {
        // No subcommand → default handler or help
        if (opts.defaultHandler) {
          await opts.defaultHandler(ctx);
        } else {
          const lines = [`*/${opts.name}* — ${opts.description}`, ''];
          for (const sub of opts.subcommands) {
            lines.push(`  \`/${opts.name} ${sub.name}\` — ${sub.description}`);
          }
          const output = lines.join('\n');
          try {
            await ctx.reply(output, { parse_mode: 'Markdown' });
          } catch {
            await ctx.reply(output.replace(/[*`]/g, ''));
          }
        }
        return;
      }

      // Parse subcommand: first word is the subcommand name
      const spaceIdx = afterCmd.indexOf(' ');
      const subName = (spaceIdx >= 0 ? afterCmd.slice(0, spaceIdx) : afterCmd).toLowerCase();
      const sub = subMap.get(subName);

      if (sub) {
        await sub.handler(ctx);
      } else {
        // Unknown subcommand — show help
        const available = opts.subcommands.map((s) => s.name).join(', ');
        await ctx.reply(`未知子指令「${subName}」。可用: ${available}`);
      }
    },
  });
}
