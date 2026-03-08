import { describe, it, expect } from 'vitest';
import { ChatQueue } from '../../src/core/queue.js';

describe('ChatQueue', () => {
  it('executes tasks in order per chat', async () => {
    const queue = new ChatQueue();
    const order: number[] = [];

    const p1 = queue.enqueue(1, async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push(1);
      return 'a';
    });

    const p2 = queue.enqueue(1, async () => {
      order.push(2);
      return 'b';
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('a');
    expect(r2).toBe('b');
    expect(order).toEqual([1, 2]);
  });

  it('different chats execute independently', async () => {
    const queue = new ChatQueue();
    const order: string[] = [];

    const p1 = queue.enqueue(1, async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push('chat1');
    });

    const p2 = queue.enqueue(2, async () => {
      order.push('chat2');
    });

    await Promise.all([p1, p2]);
    // chat2 should finish before chat1 since they're independent
    expect(order[0]).toBe('chat2');
    expect(order[1]).toBe('chat1');
  });

  it('tracks pending count', async () => {
    const queue = new ChatQueue();
    expect(queue.pending).toBe(0);

    const p = queue.enqueue(1, async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(queue.hasPending(1)).toBe(true);
    await p;
    expect(queue.hasPending(1)).toBe(false);
  });

  it('handles task errors without breaking the queue', async () => {
    const queue = new ChatQueue();

    const p1 = queue.enqueue(1, async () => {
      throw new Error('task error');
    });

    await expect(p1).rejects.toThrow('task error');

    // Queue should still work after error
    const p2 = queue.enqueue(1, async () => 'recovered');
    expect(await p2).toBe('recovered');
  });
});
