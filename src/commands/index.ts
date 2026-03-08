import type { Bot } from 'grammy';
import type { BotContext } from '../bot.js';
import { commandRegistry } from '../telegram/command-registry.js';
import { registerStartCommand } from './start.js';
import { registerHelpCommand } from './help.js';
import { registerStatusCommand } from './status.js';
import { registerCCCommands } from './cc.js';
import { registerEvolveCommands } from './evolve.js';
import { registerSoulCommand } from './soul.js';
import { registerContentCommand } from './content.js';
import { registerSysCommand } from './sys.js';
import { registerKnowledgeCommands } from './knowledge.js';
import { registerPlanCommand } from './plan.js';
import { registerCostCommand } from './cost.js';
import { registerWorkersCommand } from './workers.js';
import { registerMenuCommand } from './menu.js';
import { registerAgentManagerCommand } from './agent-manager.js';
import { registerTeamCommand } from './team.js';

/** Register all core commands and bind to bot */
export function registerCommands(bot: Bot<BotContext>): void {
  // Register all command handlers
  registerStartCommand();
  registerMenuCommand();
  registerHelpCommand();
  registerStatusCommand();
  registerCCCommands();
  registerEvolveCommands();
  registerSoulCommand();
  registerContentCommand();
  registerSysCommand();
  registerKnowledgeCommands();
  registerPlanCommand();
  registerCostCommand();
  registerWorkersCommand();
  registerAgentManagerCommand();
  registerTeamCommand();

  // Bind all registered commands to the bot
  commandRegistry.bindToBot(bot);
}
