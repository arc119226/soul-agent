import { describe, it, expect, vi, beforeAll } from 'vitest';

// Ensure BOT_TOKEN exists before config module loads (CI has no .env)
beforeAll(() => {
  if (!process.env.BOT_TOKEN) {
    process.env.BOT_TOKEN = 'test-token-for-ci';
  }
});

describe('Config', () => {
  it('loads config from environment', async () => {
    vi.resetModules();
    const { config } = await import('../../src/config.js');
    expect(config.BOT_TOKEN).toBeDefined();
    expect(config.BOT_TOKEN.length).toBeGreaterThan(0);
    expect(typeof config.APPROVAL_PORT).toBe('number');
    expect(typeof config.DAILY_REQUEST_LIMIT).toBe('number');
  });

  it('has correct defaults', async () => {
    vi.resetModules();
    const { config } = await import('../../src/config.js');
    expect(config.TIMEZONE).toBe('Asia/Taipei');
  });
});
