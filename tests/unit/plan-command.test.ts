import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Plan, PlanStatus } from '../../src/planning/plan-manager.js';

// In-memory plan store
const planStore = new Map<string, Plan>();

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'test1234',
    title: '測試計劃',
    intention: '測試計劃功能',
    approach: '寫測試',
    steps: [
      { id: 1, description: '第一步', completed: false },
      { id: 2, description: '第二步', completed: false },
    ],
    triggeredBy: 'user',
    triggerContext: 'testing',
    successCriteria: '測試通過',
    status: 'active',
    createdAt: '2026-02-13T10:00:00.000Z',
    startedAt: '2026-02-13T10:01:00.000Z',
    ...overrides,
  };
}

vi.mock('../../src/planning/plan-manager.js', () => ({
  getActivePlans: vi.fn(async () => {
    return [...planStore.values()].filter(
      (p) => p.status === 'active' || p.status === 'draft',
    );
  }),
  getRecentPlans: vi.fn(async (n: number) => {
    return [...planStore.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, n);
  }),
  loadPlan: vi.fn(async (id: string) => {
    return planStore.get(id) || null;
  }),
  activatePlan: vi.fn(async (id: string) => {
    const plan = planStore.get(id);
    if (!plan) return { ok: false, error: `Plan not found: ${id}` };
    plan.status = 'active';
    plan.startedAt = new Date().toISOString();
    return { ok: true, message: 'Plan activated', value: plan };
  }),
  completeStep: vi.fn(async (id: string, stepId: number) => {
    const plan = planStore.get(id);
    if (!plan) return { ok: false, error: `Plan not found: ${id}` };
    const step = plan.steps.find((s) => s.id === stepId);
    if (!step) return { ok: false, error: `Step not found: ${stepId}` };
    step.completed = true;
    step.completedAt = new Date().toISOString();
    return { ok: true, message: 'Step completed', value: plan };
  }),
  completePlan: vi.fn(async (id: string, retro: string, _lessons: string, satisfaction: number) => {
    const plan = planStore.get(id);
    if (!plan) return { ok: false, error: `Plan not found: ${id}` };
    plan.status = 'completed' as PlanStatus;
    plan.completedAt = new Date().toISOString();
    plan.retrospective = retro;
    plan.satisfactionLevel = satisfaction;
    return { ok: true, message: 'Plan completed', value: plan };
  }),
  abandonPlan: vi.fn(async (id: string, reason: string) => {
    const plan = planStore.get(id);
    if (!plan) return { ok: false, error: `Plan not found: ${id}` };
    plan.status = 'abandoned' as PlanStatus;
    plan.retrospective = `放棄原因：${reason}`;
    return { ok: true, message: 'Plan abandoned', value: plan };
  }),
}));

vi.mock('../../src/telegram/command-registry.js', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const callbacks = new Map<string, (...args: unknown[]) => unknown>();
  return {
    commandRegistry: {
      registerCommand: vi.fn((entry: { name: string; handler: (...args: unknown[]) => unknown }) => {
        handlers.set(entry.name, entry.handler);
      }),
      registerCallback: vi.fn((prefix: string, handler: (...args: unknown[]) => unknown) => {
        callbacks.set(prefix, handler);
      }),
      _handlers: handlers,
      _callbacks: callbacks,
    },
  };
});

vi.mock('../../src/telegram/helpers.js', () => ({
  sendLongMessage: vi.fn(),
}));

// --- Test helpers ---

function makeCtx(messageText = '') {
  const sent: unknown[] = [];
  return {
    ctx: {
      message: { text: messageText },
      chat: { id: 123 },
      from: { id: 1 },
      reply: vi.fn(async (text: string, opts?: unknown) => { sent.push({ text, opts }); }),
      api: { sendMessage: vi.fn() },
    },
    sent,
  };
}

describe('Plan Command', () => {
  beforeEach(() => {
    planStore.clear();
    vi.clearAllMocks();
  });

  it('registerPlanCommand registers command and callbacks', async () => {
    const { registerPlanCommand } = await import('../../src/commands/plan.js');
    const { commandRegistry } = await import('../../src/telegram/command-registry.js');

    registerPlanCommand();

    expect(commandRegistry.registerCommand).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'plan' }),
    );
    expect(commandRegistry.registerCallback).toHaveBeenCalledWith('plan:view:', expect.any(Function));
    expect(commandRegistry.registerCallback).toHaveBeenCalledWith('plan:activate:', expect.any(Function));
    expect(commandRegistry.registerCallback).toHaveBeenCalledWith('plan:step:', expect.any(Function));
    expect(commandRegistry.registerCallback).toHaveBeenCalledWith('plan:complete:', expect.any(Function));
    expect(commandRegistry.registerCallback).toHaveBeenCalledWith('plan:abandon:', expect.any(Function));
    expect(commandRegistry.registerCallback).toHaveBeenCalledWith('plan:list', expect.any(Function));
  });

  it('/plan shows active plans', async () => {
    planStore.set('test1234', makePlan());

    const { registerPlanCommand } = await import('../../src/commands/plan.js');
    const { commandRegistry } = await import('../../src/telegram/command-registry.js');
    const { sendLongMessage } = await import('../../src/telegram/helpers.js');

    registerPlanCommand();

    const handler = (commandRegistry as unknown as { _handlers: Map<string, CallableFunction> })._handlers.get('plan');
    const { ctx } = makeCtx('/plan');
    await handler!(ctx);

    expect(sendLongMessage).toHaveBeenCalledWith(
      ctx,
      123,
      expect.stringContaining('測試計劃'),
    );
  });

  it('/plan shows empty state when no active plans', async () => {
    const { registerPlanCommand } = await import('../../src/commands/plan.js');
    const { commandRegistry } = await import('../../src/telegram/command-registry.js');

    registerPlanCommand();

    const handler = (commandRegistry as unknown as { _handlers: Map<string, CallableFunction> })._handlers.get('plan');
    const { ctx } = makeCtx('/plan');
    await handler!(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(
      '目前沒有進行中的計劃。',
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
  });

  it('/plan list shows recent plans', async () => {
    planStore.set('test1234', makePlan());
    planStore.set('test5678', makePlan({
      id: 'test5678',
      title: '已完成的計劃',
      status: 'completed',
      completedAt: '2026-02-13T12:00:00.000Z',
    }));

    const { registerPlanCommand } = await import('../../src/commands/plan.js');
    const { commandRegistry } = await import('../../src/telegram/command-registry.js');
    const { sendLongMessage } = await import('../../src/telegram/helpers.js');

    registerPlanCommand();

    const handler = (commandRegistry as unknown as { _handlers: Map<string, CallableFunction> })._handlers.get('plan');
    const { ctx } = makeCtx('/plan list');
    await handler!(ctx);

    expect(sendLongMessage).toHaveBeenCalledWith(
      ctx,
      123,
      expect.stringContaining('最近的計劃'),
    );
  });

  it('/plan view shows plan details', async () => {
    planStore.set('test1234', makePlan());

    const { registerPlanCommand } = await import('../../src/commands/plan.js');
    const { commandRegistry } = await import('../../src/telegram/command-registry.js');
    const { sendLongMessage } = await import('../../src/telegram/helpers.js');

    registerPlanCommand();

    const handler = (commandRegistry as unknown as { _handlers: Map<string, CallableFunction> })._handlers.get('plan');
    const { ctx } = makeCtx('/plan view test1234');
    await handler!(ctx);

    expect(sendLongMessage).toHaveBeenCalledWith(
      ctx,
      123,
      expect.stringContaining('意圖'),
    );
  });

  it('/plan view shows not found for invalid id', async () => {
    const { registerPlanCommand } = await import('../../src/commands/plan.js');
    const { commandRegistry } = await import('../../src/telegram/command-registry.js');

    registerPlanCommand();

    const handler = (commandRegistry as unknown as { _handlers: Map<string, CallableFunction> })._handlers.get('plan');
    const { ctx } = makeCtx('/plan view nonexist');
    await handler!(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('找不到'));
  });

  it('/plan create shows guided prompt', async () => {
    const { registerPlanCommand } = await import('../../src/commands/plan.js');
    const { commandRegistry } = await import('../../src/telegram/command-registry.js');

    registerPlanCommand();

    const handler = (commandRegistry as unknown as { _handlers: Map<string, CallableFunction> })._handlers.get('plan');
    const { ctx } = makeCtx('/plan create');
    await handler!(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('建立新計劃'));
  });

  it('plan:step callback completes a step', async () => {
    planStore.set('test1234', makePlan());

    const { registerPlanCommand } = await import('../../src/commands/plan.js');
    const { commandRegistry } = await import('../../src/telegram/command-registry.js');

    registerPlanCommand();

    const stepCallback = (commandRegistry as unknown as { _callbacks: Map<string, CallableFunction> })._callbacks.get('plan:step:');
    const { ctx } = makeCtx();
    await stepCallback!(ctx, 'test1234:1'); // planId:stepId

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('已完成步驟'));
  });

  it('plan:activate callback activates a draft plan', async () => {
    planStore.set('draft01', makePlan({ id: 'draft01', status: 'draft' }));

    const { registerPlanCommand } = await import('../../src/commands/plan.js');
    const { commandRegistry } = await import('../../src/telegram/command-registry.js');

    registerPlanCommand();

    const activateCallback = (commandRegistry as unknown as { _callbacks: Map<string, CallableFunction> })._callbacks.get('plan:activate:');
    const { ctx } = makeCtx();
    await activateCallback!(ctx, 'draft01');

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('已啟動'));
  });

  it('plan:complete callback completes a plan', async () => {
    planStore.set('test1234', makePlan());

    const { registerPlanCommand } = await import('../../src/commands/plan.js');
    const { commandRegistry } = await import('../../src/telegram/command-registry.js');

    registerPlanCommand();

    const completeCallback = (commandRegistry as unknown as { _callbacks: Map<string, CallableFunction> })._callbacks.get('plan:complete:');
    const { ctx } = makeCtx();
    await completeCallback!(ctx, 'test1234');

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('已完成'));
  });

  it('plan:abandon callback abandons a plan', async () => {
    planStore.set('test1234', makePlan());

    const { registerPlanCommand } = await import('../../src/commands/plan.js');
    const { commandRegistry } = await import('../../src/telegram/command-registry.js');

    registerPlanCommand();

    const abandonCallback = (commandRegistry as unknown as { _callbacks: Map<string, CallableFunction> })._callbacks.get('plan:abandon:');
    const { ctx } = makeCtx();
    await abandonCallback!(ctx, 'test1234');

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('已放棄'));
  });

  it('/plan step shows usage hint for bad arguments', async () => {
    const { registerPlanCommand } = await import('../../src/commands/plan.js');
    const { commandRegistry } = await import('../../src/telegram/command-registry.js');

    registerPlanCommand();

    const handler = (commandRegistry as unknown as { _handlers: Map<string, CallableFunction> })._handlers.get('plan');
    const { ctx } = makeCtx('/plan step');
    await handler!(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('用法'));
  });
});
