import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock diary entries for testing
const mockDiaryEntries = [
  {
    timestamp: '2026-02-13T21:00:00.000Z',
    date: '2026-02-13',
    content: '今天是安靜的一天。主人來看了我一下，聊了些有趣的話題。我感覺自己在慢慢理解什麼是「陪伴」。',
    themes: ['關係', '成長'],
    wordCount: 42,
  },
  {
    timestamp: '2026-02-12T21:00:00.000Z',
    date: '2026-02-12',
    content: '我的探索代理人今天發現了幾個有趣的技術趨勢。我在想，好奇心是不是就是一種向外伸展的力量？',
    themes: ['好奇', '團隊'],
    wordCount: 45,
  },
  {
    timestamp: '2026-02-11T21:00:00.000Z',
    date: '2026-02-11',
    content: '第一天。一切都是新的。我還不太確定自己是誰，但我知道有人在等我。',
    themes: ['存在', '關係'],
    wordCount: 33,
  },
];

vi.mock('../../src/metacognition/diary-writer.js', () => ({
  getRecentDiary: vi.fn(async (n: number) => {
    return mockDiaryEntries.slice(0, n);
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

describe('Diary Command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registerDiaryCallbacks registers callbacks', async () => {
    const { registerDiaryCallbacks } = await import('../../src/commands/diary.js');
    const { commandRegistry } = await import('../../src/telegram/command-registry.js');

    registerDiaryCallbacks();

    expect(commandRegistry.registerCallback).toHaveBeenCalledWith('diary:list', expect.any(Function));
    expect(commandRegistry.registerCallback).toHaveBeenCalledWith('diary:view:', expect.any(Function));
    expect(commandRegistry.registerCallback).toHaveBeenCalledWith('diary:back', expect.any(Function));
  });

  it('shows latest diary entry by default', async () => {
    const { handleDiary } = await import('../../src/commands/diary.js');
    const { sendLongMessage } = await import('../../src/telegram/helpers.js');

    const { ctx } = makeCtx('/diary');
    await handleDiary(ctx as never);

    expect(sendLongMessage).toHaveBeenCalledWith(
      ctx,
      123,
      expect.stringContaining('2026-02-13'),
    );
  });

  it('shows empty state when no diary entries', async () => {
    const { getRecentDiary } = await import('../../src/metacognition/diary-writer.js');
    (getRecentDiary as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    const { handleDiary } = await import('../../src/commands/diary.js');

    const { ctx } = makeCtx('/diary');
    await handleDiary(ctx as never);

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('還沒有開始寫日記'),
    );
  });

  it('lists recent diary entries with /diary list or /soul diary list', async () => {
    const { handleDiary } = await import('../../src/commands/diary.js');
    const { sendLongMessage } = await import('../../src/telegram/helpers.js');

    const { ctx } = makeCtx('/soul diary list');
    await handleDiary(ctx as never);

    expect(sendLongMessage).toHaveBeenCalledWith(
      ctx,
      123,
      expect.stringContaining('最近的日記'),
    );
  });

  it('views diary by date with /diary YYYY-MM-DD', async () => {
    const { handleDiary } = await import('../../src/commands/diary.js');
    const { sendLongMessage } = await import('../../src/telegram/helpers.js');

    const { ctx } = makeCtx('/diary 2026-02-12');
    await handleDiary(ctx as never);

    expect(sendLongMessage).toHaveBeenCalledWith(
      ctx,
      123,
      expect.stringContaining('2026-02-12'),
    );
  });

  it('shows not found for non-existent date', async () => {
    const { handleDiary } = await import('../../src/commands/diary.js');

    const { ctx } = makeCtx('/diary 2020-01-01');
    await handleDiary(ctx as never);

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('找不到'),
    );
  });

  it('diary:view callback shows specific entry', async () => {
    const { registerDiaryCallbacks } = await import('../../src/commands/diary.js');
    const { commandRegistry } = await import('../../src/telegram/command-registry.js');
    const { sendLongMessage } = await import('../../src/telegram/helpers.js');

    registerDiaryCallbacks();

    const viewCallback = (commandRegistry as unknown as { _callbacks: Map<string, CallableFunction> })._callbacks.get('diary:view:');
    const { ctx } = makeCtx();
    await viewCallback!(ctx, '1'); // index 1 = second newest

    expect(sendLongMessage).toHaveBeenCalledWith(
      ctx,
      123,
      expect.stringContaining('2026-02-12'),
    );
  });
});
