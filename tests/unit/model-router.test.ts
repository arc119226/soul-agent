import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: {
    MODEL_TIER_HAIKU: 'claude-haiku-4-5-20251001',
    MODEL_TIER_SONNET: 'claude-sonnet-4-6',
    MODEL_TIER_OPUS: '',
  },
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(async () => {}),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { routeMessage } from '../../src/telegram/model-router.js';

describe('Model Router', () => {
  describe('fast-path: ultra-short messages → haiku', () => {
    it('routes single character to haiku', async () => {
      const result = await routeMessage('嗯', 1);
      expect(result.tier).toBe('haiku');
      expect(result.reason).toContain('fast-path');
    });

    it('routes "好" to haiku', async () => {
      const result = await routeMessage('好', 1);
      expect(result.tier).toBe('haiku');
    });

    it('routes emoji to haiku', async () => {
      const result = await routeMessage('👍', 1);
      expect(result.tier).toBe('haiku');
    });
  });

  describe('fast-path: greetings → haiku', () => {
    const greetings = ['你好', '嗨', 'hi', 'hello', 'hey', '早安', '午安', '晚安', 'bye', '哈囉'];

    for (const g of greetings) {
      it(`routes "${g}" to haiku`, async () => {
        const result = await routeMessage(g, 1);
        expect(result.tier).toBe('haiku');
        expect(result.reason).toContain('fast-path');
      });
    }

    it('routes greeting with punctuation', async () => {
      const result = await routeMessage('你好！', 1);
      expect(result.tier).toBe('haiku');
    });

    it('routes "good morning" to haiku', async () => {
      const result = await routeMessage('good morning', 1);
      expect(result.tier).toBe('haiku');
    });
  });

  describe('fast-path: confirmations → haiku', () => {
    const confirmations = ['好', '好的', 'OK', 'ok', '收到', '了解', '謝謝', '辛苦了', '嗯', '對', '沒問題'];

    for (const c of confirmations) {
      it(`routes "${c}" to haiku`, async () => {
        const result = await routeMessage(c, 1);
        expect(result.tier).toBe('haiku');
      });
    }
  });

  describe('fast-path: code block → opus', () => {
    it('routes message with code block to opus', async () => {
      const result = await routeMessage('看看這段 ```const x = 1;```', 1);
      expect(result.tier).toBe('opus');
      expect(result.reason).toContain('code-block');
    });
  });

  describe('fast-path: URL → opus', () => {
    it('routes message with http URL to opus', async () => {
      const result = await routeMessage('請看 http://example.com', 1);
      expect(result.tier).toBe('opus');
      expect(result.reason).toContain('url');
    });

    it('routes message with https URL to opus', async () => {
      const result = await routeMessage('https://github.com/repo', 1);
      expect(result.tier).toBe('opus');
      expect(result.reason).toContain('url');
    });
  });

  describe('default fallback → sonnet for ambiguous messages', () => {
    it('defaults to sonnet for medium-length non-technical text', async () => {
      const result = await routeMessage('今天天氣好像不太好，你覺得會不會下雨呢', 1);
      expect(result.tier).toBe('sonnet');
      expect(result.reason).toContain('default-fallback');
    });

    it('routes to opus when text contains new TECH_CN terms like 分類', async () => {
      const result = await routeMessage('這是一些比較模糊的訊息內容，不太確定要怎麼分類', 1);
      expect(result.tier).toBe('opus');
      expect(result.reason).toContain('technical-keywords');
    });

    it('routes long messages to sonnet via fast-path', async () => {
      const longText = '這是一段比較長的訊息，'.repeat(20);
      const result = await routeMessage(longText, 1);
      expect(result.tier).toBe('sonnet');
      expect(result.reason).toContain('long-message');
    });
  });

  describe('fast-path: intent marker ~ → opus', () => {
    it('routes ~prefixed message to opus', async () => {
      const result = await routeMessage('~分析一下這個架構的優缺點', 1);
      expect(result.tier).toBe('opus');
      expect(result.reason).toContain('intent-marker');
    });

    it('routes fullwidth ～ prefix to opus', async () => {
      const result = await routeMessage('～深入思考這個問題', 1);
      expect(result.tier).toBe('opus');
      expect(result.reason).toContain('intent-marker');
    });

    it('strips ~ prefix in strippedText', async () => {
      const result = await routeMessage('~分析一下這個架構', 1);
      expect(result.strippedText).toBe('分析一下這個架構');
    });

    it('strips ～ prefix with space in strippedText', async () => {
      const result = await routeMessage('～ 深入研究', 1);
      expect(result.strippedText).toBe('深入研究');
    });

    it('overrides ultra-short heuristic (e.g. ~好)', async () => {
      const result = await routeMessage('~好', 1);
      expect(result.tier).toBe('opus');
      expect(result.reason).toContain('intent-marker');
    });

    it('overrides greeting heuristic (e.g. ~你好)', async () => {
      const result = await routeMessage('~你好', 1);
      expect(result.tier).toBe('opus');
      expect(result.reason).toContain('intent-marker');
    });

    it('has skipResume=false and lightContext=false', async () => {
      const result = await routeMessage('~思考', 1);
      expect(result.skipResume).toBe(false);
      expect(result.lightContext).toBe(false);
    });
  });

  describe('fast-path: intent marker ? → sonnet', () => {
    it('routes ?prefixed message to sonnet', async () => {
      const result = await routeMessage('?幫我整理一下今天的筆記', 1);
      expect(result.tier).toBe('sonnet');
      expect(result.reason).toContain('intent-marker');
    });

    it('routes fullwidth ？ prefix to sonnet', async () => {
      const result = await routeMessage('？分析一下這篇文章的重點', 1);
      expect(result.tier).toBe('sonnet');
      expect(result.reason).toContain('intent-marker');
    });

    it('strips ? prefix in strippedText', async () => {
      const result = await routeMessage('?整理筆記', 1);
      expect(result.strippedText).toBe('整理筆記');
    });

    it('strips ？ prefix with space in strippedText', async () => {
      const result = await routeMessage('？ 摘要重點', 1);
      expect(result.strippedText).toBe('摘要重點');
    });

    it('overrides ultra-short heuristic (e.g. ?好)', async () => {
      const result = await routeMessage('?好', 1);
      expect(result.tier).toBe('sonnet');
      expect(result.reason).toContain('intent-marker');
    });

    it('has skipResume=false and lightContext=false', async () => {
      const result = await routeMessage('?思考', 1);
      expect(result.skipResume).toBe(false);
      expect(result.lightContext).toBe(false);
    });
  });

  describe('buildDecision properties', () => {
    it('haiku tier has skipResume=true and lightContext=true', async () => {
      const result = await routeMessage('你好', 1);
      expect(result.skipResume).toBe(true);
      expect(result.lightContext).toBe(true);
    });

    it('opus tier has skipResume=false and lightContext=false', async () => {
      const result = await routeMessage('```code```', 1);
      expect(result.skipResume).toBe(false);
      expect(result.lightContext).toBe(false);
    });

    it('includes model ID in decision', async () => {
      const result = await routeMessage('你好', 1);
      expect(result.model).toBe('claude-haiku-4-5-20251001');
    });
  });
});
