import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('TypedEventBus', () => {
  // Fresh eventBus per test via dynamic import + resetModules
  let eventBus: typeof import('../../src/core/event-bus.js')['eventBus'];

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../../src/core/event-bus.js');
    eventBus = mod.eventBus;
    eventBus.clear();
  });

  it('calls handler when event is emitted', async () => {
    const handler = vi.fn();
    eventBus.on('heartbeat:tick', handler);

    await eventBus.emit('heartbeat:tick', { timestamp: 123, state: 'active' });

    expect(handler).toHaveBeenCalledWith({ timestamp: 123, state: 'active' });
  });

  it('supports multiple handlers for the same event', async () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    eventBus.on('heartbeat:tick', handler1);
    eventBus.on('heartbeat:tick', handler2);

    await eventBus.emit('heartbeat:tick', { timestamp: 1, state: 'resting' });

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it('removes handler with off()', async () => {
    const handler = vi.fn();
    eventBus.on('heartbeat:tick', handler);
    eventBus.off('heartbeat:tick', handler);

    await eventBus.emit('heartbeat:tick', { timestamp: 1, state: 'active' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('does nothing when emitting event with no handlers', async () => {
    // Should not throw
    await eventBus.emit('heartbeat:tick', { timestamp: 1, state: 'active' });
  });

  it('handles async handlers', async () => {
    const order: number[] = [];
    eventBus.on('milestone:reached', async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push(1);
    });
    eventBus.on('milestone:reached', async () => {
      order.push(2);
    });

    await eventBus.emit('milestone:reached', { type: 'test', description: 'test' });

    expect(order).toContain(1);
    expect(order).toContain(2);
  });

  it('catches sync handler errors without crashing', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const good = vi.fn();

    eventBus.on('bot:error', () => { throw new Error('boom'); });
    eventBus.on('bot:error', good);

    await eventBus.emit('bot:error', { error: 'test', module: 'test' });

    expect(good).toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('clear() removes all handlers', async () => {
    const handler = vi.fn();
    eventBus.on('heartbeat:tick', handler);
    eventBus.clear();

    await eventBus.emit('heartbeat:tick', { timestamp: 1, state: 'active' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('listenerCount() returns 0 for unregistered event', () => {
    expect(eventBus.listenerCount('heartbeat:tick')).toBe(0);
  });

  it('listenerCount() returns correct count after on/off', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    eventBus.on('heartbeat:tick', h1);
    expect(eventBus.listenerCount('heartbeat:tick')).toBe(1);

    eventBus.on('heartbeat:tick', h2);
    expect(eventBus.listenerCount('heartbeat:tick')).toBe(2);

    eventBus.off('heartbeat:tick', h1);
    expect(eventBus.listenerCount('heartbeat:tick')).toBe(1);
  });

  it('listenerCounts() returns counts for all registered events', () => {
    eventBus.on('heartbeat:tick', vi.fn());
    eventBus.on('heartbeat:tick', vi.fn());
    eventBus.on('milestone:reached', vi.fn());

    const counts = eventBus.listenerCounts();
    expect(counts['heartbeat:tick']).toBe(2);
    expect(counts['milestone:reached']).toBe(1);
  });

  it('listenerCounts() returns empty object when no handlers', () => {
    expect(eventBus.listenerCounts()).toEqual({});
  });

  it('different events are independent', async () => {
    const tickHandler = vi.fn();
    const milestoneHandler = vi.fn();

    eventBus.on('heartbeat:tick', tickHandler);
    eventBus.on('milestone:reached', milestoneHandler);

    await eventBus.emit('heartbeat:tick', { timestamp: 1, state: 'active' });

    expect(tickHandler).toHaveBeenCalledTimes(1);
    expect(milestoneHandler).not.toHaveBeenCalled();
  });
});
