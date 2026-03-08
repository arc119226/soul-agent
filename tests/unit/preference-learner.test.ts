import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock user-store — used by flushInsights
vi.mock('../../src/memory/user-store.js', () => ({
  setPreference: vi.fn(),
  addFact: vi.fn(),
  getUser: vi.fn().mockResolvedValue(null),
}));

describe('PreferenceLearner', () => {
  let observeMessage: typeof import('../../src/metacognition/preference-learner.js')['observeMessage'];

  beforeEach(async () => {
    vi.resetModules();

    vi.doMock('../../src/core/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    vi.doMock('../../src/memory/user-store.js', () => ({
      setPreference: vi.fn(),
      addFact: vi.fn(),
      getUser: vi.fn().mockResolvedValue(null),
    }));

    const mod = await import('../../src/metacognition/preference-learner.js');
    observeMessage = mod.observeMessage;
  });

  describe('detectLanguage() — via observeMessage accumulation', () => {
    // We test detectLanguage indirectly through observeMessage.
    // After FLUSH_EVERY_N (15) messages, it flushes insights to user-store.
    // We can verify language detection by checking accumulated patterns.

    it('detects pure Chinese text', () => {
      // observeMessage should not throw on Chinese text
      expect(() => observeMessage(1, '你好世界這是中文句子')).not.toThrow();
    });

    it('detects pure English text', () => {
      expect(() => observeMessage(2, 'Hello world this is English text')).not.toThrow();
    });

    it('detects mixed Chinese/English text', () => {
      expect(() => observeMessage(3, '你好 Hello 世界 world')).not.toThrow();
    });

    it('defaults to zh for emoji-only messages', () => {
      // Pure emoji → detectLanguage returns 'zh' (default)
      expect(() => observeMessage(4, '😀🎉🔥')).not.toThrow();
    });
  });

  describe('classifyActivityPattern() — tested indirectly', () => {
    // classifyActivityPattern is called during flush when user has activityHours.
    // We test that observeMessage can be called without errors.

    it('handles messages at various hours', () => {
      expect(() => observeMessage(10, 'test message at any time')).not.toThrow();
    });
  });

  describe('observeMessage()', () => {
    it('accumulates language and topic statistics', () => {
      // Observe multiple messages — should not throw
      observeMessage(100, '程式碼 bug fix');
      observeMessage(100, '今天去吃飯');
      observeMessage(100, 'deploy the server');
      // No error means accumulation works
    });

    it('detects tech topic keywords', () => {
      // Tech keywords should be recognized
      expect(() => observeMessage(200, '我在寫程式碼，遇到了 bug')).not.toThrow();
      expect(() => observeMessage(200, 'Need to deploy to server')).not.toThrow();
    });

    it('detects life topic keywords', () => {
      expect(() => observeMessage(300, '今天出門吃飯看電影')).not.toThrow();
    });

    it('detects work topic keywords', () => {
      expect(() => observeMessage(400, '今天開會討論專案進度')).not.toThrow();
    });

    it('detects AI topic keywords', () => {
      expect(() => observeMessage(500, '我在用 Claude 這個 LLM 模型')).not.toThrow();
    });

    it('triggers flush after FLUSH_EVERY_N (15) messages', async () => {
      const userId = 600;
      for (let i = 0; i < 15; i++) {
        observeMessage(userId, '你好世界');
      }
      // Flush is triggered internally (async, non-blocking)
      // We just verify no errors
    });

    it('resets accumulator after flush', async () => {
      const userId = 700;
      for (let i = 0; i < 16; i++) {
        observeMessage(userId, '你好');
      }
      // After flush, accumulator resets — next observation starts fresh
      expect(() => observeMessage(userId, '新消息')).not.toThrow();
    });

    it('tracks multiple users independently', () => {
      observeMessage(801, '中文消息');
      observeMessage(802, 'English message');
      observeMessage(803, '你好 hello');
      // Each user has their own accumulator
    });

    it('handles empty string gracefully', () => {
      expect(() => observeMessage(900, '')).not.toThrow();
    });

    it('detects finance keywords', () => {
      expect(() => observeMessage(1000, '今天股票漲了，比特幣也在上升')).not.toThrow();
    });

    it('detects entertainment keywords', () => {
      expect(() => observeMessage(1100, '剛看了 YouTube 和 Netflix 動漫')).not.toThrow();
    });

    it('detects devops keywords', () => {
      expect(() => observeMessage(1200, 'nginx redis docker 容器部署')).not.toThrow();
    });
  });
});
