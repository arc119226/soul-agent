import { eventBus } from './event-bus.js';
import { logger } from './logger.js';

type ShutdownHandler = () => void | Promise<void>;

/**
 * Graceful shutdown coordinator.
 * Registers handlers and executes them in reverse order on shutdown.
 */
class ShutdownCoordinator {
  private handlers: { name: string; fn: ShutdownHandler }[] = [];
  private shuttingDown = false;

  register(name: string, fn: ShutdownHandler): void {
    this.handlers.push({ name, fn });
  }

  async execute(reason: string, exitCode: number = 0): Promise<never> {
    if (this.shuttingDown) {
      logger.warn('shutdown', 'Shutdown already in progress, ignoring duplicate');
      // Wait forever to prevent double shutdown
      return new Promise(() => {});
    }
    this.shuttingDown = true;

    await logger.info('shutdown', `Shutdown initiated: ${reason} (exit code ${exitCode})`);
    await eventBus.emit('shutdown:start', { reason });

    // Execute handlers in reverse order (LIFO)
    for (const handler of [...this.handlers].reverse()) {
      try {
        await logger.info('shutdown', `Running shutdown handler: ${handler.name}`);
        await Promise.race([
          handler.fn(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), 10_000)
          ),
        ]);
      } catch (err) {
        await logger.error('shutdown', `Handler ${handler.name} failed`, err);
      }
    }

    await eventBus.emit('shutdown:complete', {});
    await logger.info('shutdown', 'Shutdown complete');

    process.exit(exitCode);
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }
}

export const shutdown = new ShutdownCoordinator();

// Wire up process signals
process.on('SIGINT', () => shutdown.execute('SIGINT', 0));
process.on('SIGTERM', () => shutdown.execute('SIGTERM', 0));
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  shutdown.execute(`Uncaught exception: ${err.message}`, 1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
  // Don't exit on unhandled rejections — log and continue
  logger.error('process', 'Unhandled rejection', reason);
});
