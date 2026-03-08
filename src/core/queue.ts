/**
 * Per-chat async queue — serializes operations per chatId
 * to prevent concurrent Claude CLI calls in the same chat.
 */

type Task<T> = () => Promise<T>;

export class ChatQueue {
  private queues = new Map<number, Promise<unknown>>();

  async enqueue<T>(chatId: number, task: Task<T>): Promise<T> {
    const prev = this.queues.get(chatId) ?? Promise.resolve();
    const next = prev
      .catch(() => {}) // swallow previous errors
      .then(() => task());

    this.queues.set(chatId, next);

    try {
      return await next;
    } finally {
      // Clean up if this was the last task
      if (this.queues.get(chatId) === next) {
        this.queues.delete(chatId);
      }
    }
  }

  get pending(): number {
    return this.queues.size;
  }

  hasPending(chatId: number): boolean {
    return this.queues.has(chatId);
  }
}

export const chatQueue = new ChatQueue();
