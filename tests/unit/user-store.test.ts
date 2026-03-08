import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

// ── In-memory SQLite for tests ────────────────────────────────────
let testDb: InstanceType<typeof Database>;

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY,
    name           TEXT    NOT NULL DEFAULT '',
    username       TEXT    NOT NULL DEFAULT '',
    first_seen     TEXT    NOT NULL,
    last_seen      TEXT    NOT NULL,
    message_count  INTEGER NOT NULL DEFAULT 0,
    facts          TEXT    NOT NULL DEFAULT '[]',
    preferences    TEXT    NOT NULL DEFAULT '{}',
    activity_hours TEXT    NOT NULL DEFAULT '[]'
  )`);
  return db;
}

// ── Mocks ─────────────────────────────────────────────
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

vi.mock('../../src/core/debounced-writer.js', () => ({
  writer: { schedule: vi.fn() },
}));

vi.mock('../../src/config.js', () => ({
  config: { USER_FACT_LIMIT: 5 },
}));

vi.mock('../../src/lifecycle/awareness.js', () => ({
  getCurrentHour: vi.fn(() => 14),
  loadActivityHours: vi.fn(),
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('UserStore', () => {
  let getUser: typeof import('../../src/memory/user-store.js')['getUser'];
  let getAllUsers: typeof import('../../src/memory/user-store.js')['getAllUsers'];
  let updateUser: typeof import('../../src/memory/user-store.js')['updateUser'];
  let addFact: typeof import('../../src/memory/user-store.js')['addFact'];
  let removeFact: typeof import('../../src/memory/user-store.js')['removeFact'];
  let getFacts: typeof import('../../src/memory/user-store.js')['getFacts'];
  let setPreference: typeof import('../../src/memory/user-store.js')['setPreference'];
  let resetCache: typeof import('../../src/memory/user-store.js')['resetCache'];

  beforeEach(async () => {
    vi.resetModules();

    // Fresh in-memory DB for each test
    testDb = createTestDb();

    vi.doMock('node:fs/promises', () => ({ readFile: vi.fn() }));
    vi.doMock('../../src/core/database.js', () => ({ getDb: () => testDb }));
    vi.doMock('../../src/core/debounced-writer.js', () => ({ writer: { schedule: vi.fn() } }));
    vi.doMock('../../src/config.js', () => ({ config: { USER_FACT_LIMIT: 5 } }));
    vi.doMock('../../src/lifecycle/awareness.js', () => ({
      getCurrentHour: vi.fn(() => 14),
      loadActivityHours: vi.fn(),
    }));
    vi.doMock('../../src/core/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    const mod = await import('../../src/memory/user-store.js');
    getUser = mod.getUser;
    getAllUsers = mod.getAllUsers;
    updateUser = mod.updateUser;
    addFact = mod.addFact;
    removeFact = mod.removeFact;
    getFacts = mod.getFacts;
    setPreference = mod.setPreference;
    resetCache = mod.resetCache;
  });

  describe('updateUser()', () => {
    it('creates a new user profile with firstSeen', async () => {
      const user = await updateUser(123, { name: 'Arc', username: 'arc123' });
      expect(user.id).toBe(123);
      expect(user.name).toBe('Arc');
      expect(user.username).toBe('arc123');
      expect(user.firstSeen).toBeDefined();
      expect(user.messageCount).toBe(1);
      expect(user.facts).toEqual([]);
      expect(user.preferences).toEqual({});
    });

    it('updates existing user: lastSeen + messageCount++', async () => {
      await updateUser(123, { name: 'Arc' });
      const user = await updateUser(123, { name: 'Arc' });
      expect(user.messageCount).toBe(2);
    });

    it('tracks activity hours', async () => {
      const user = await updateUser(123, { name: 'Arc' });
      expect(user.activityHours).toContain(14);
    });

    it('caps activity hours at 200', async () => {
      // Pre-load a user with 200 activity hours directly in SQLite
      testDb.prepare(
        `INSERT INTO users (id, name, username, first_seen, last_seen, message_count, facts, preferences, activity_hours)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(123, 'Arc', '', '2026-01-01', '2026-01-01', 200, '[]', '{}', JSON.stringify(new Array(200).fill(10)));

      // Need fresh import to pick up the pre-populated DB
      vi.resetModules();
      vi.doMock('node:fs/promises', () => ({ readFile: vi.fn() }));
      vi.doMock('../../src/core/database.js', () => ({ getDb: () => testDb }));
      vi.doMock('../../src/core/debounced-writer.js', () => ({ writer: { schedule: vi.fn() } }));
      vi.doMock('../../src/config.js', () => ({ config: { USER_FACT_LIMIT: 5 } }));
      vi.doMock('../../src/lifecycle/awareness.js', () => ({
        getCurrentHour: vi.fn(() => 14),
        loadActivityHours: vi.fn(),
      }));
      vi.doMock('../../src/core/logger.js', () => ({
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      }));

      const mod2 = await import('../../src/memory/user-store.js');
      const user = await mod2.updateUser(123, { name: 'Arc' });
      expect(user.activityHours!.length).toBeLessThanOrEqual(200);
    });
  });

  describe('getUser()', () => {
    it('returns user profile after creation', async () => {
      await updateUser(123, { name: 'Arc' });
      const user = await getUser(123);
      expect(user).toBeDefined();
      expect(user!.name).toBe('Arc');
    });

    it('returns undefined for non-existent user', async () => {
      const user = await getUser(999);
      expect(user).toBeUndefined();
    });
  });

  describe('addFact()', () => {
    it('adds a fact to existing user', async () => {
      await updateUser(123, { name: 'Arc' });
      const result = await addFact(123, 'Likes TypeScript');
      expect(result).toBe(true);

      const facts = await getFacts(123);
      expect(facts).toContain('Likes TypeScript');
    });

    it('returns false when user does not exist', async () => {
      const result = await addFact(999, 'Some fact');
      expect(result).toBe(false);
    });

    it('deduplicates facts (case-insensitive)', async () => {
      await updateUser(123, { name: 'Arc' });
      await addFact(123, 'Likes TypeScript');
      const result = await addFact(123, 'likes typescript');
      expect(result).toBe(false);
    });

    it('removes oldest fact when exceeding limit', async () => {
      await updateUser(123, { name: 'Arc' });
      for (let i = 0; i < 5; i++) {
        await addFact(123, `fact-${i}`);
      }
      // Now at limit (5), adding one more should remove the oldest
      await addFact(123, 'fact-new');

      const facts = await getFacts(123);
      expect(facts).not.toContain('fact-0');
      expect(facts).toContain('fact-new');
      expect(facts.length).toBeLessThanOrEqual(5);
    });
  });

  describe('removeFact()', () => {
    it('removes a fact by substring match', async () => {
      await updateUser(123, { name: 'Arc' });
      await addFact(123, 'Loves TypeScript programming');

      const result = await removeFact(123, 'TypeScript');
      expect(result).toBe(true);

      const facts = await getFacts(123);
      expect(facts).not.toContain('Loves TypeScript programming');
    });

    it('returns false when no match', async () => {
      await updateUser(123, { name: 'Arc' });
      const result = await removeFact(123, 'nonexistent');
      expect(result).toBe(false);
    });

    it('returns false when user does not exist', async () => {
      const result = await removeFact(999, 'anything');
      expect(result).toBe(false);
    });
  });

  describe('getFacts()', () => {
    it('returns facts array for existing user', async () => {
      await updateUser(123, { name: 'Arc' });
      await addFact(123, 'Fact 1');
      await addFact(123, 'Fact 2');

      const facts = await getFacts(123);
      expect(facts).toEqual(['Fact 1', 'Fact 2']);
    });

    it('returns empty array for non-existent user', async () => {
      const facts = await getFacts(999);
      expect(facts).toEqual([]);
    });
  });

  describe('setPreference()', () => {
    it('sets a preference on existing user', async () => {
      await updateUser(123, { name: 'Arc' });
      await setPreference(123, 'language', '中文為主');

      const user = await getUser(123);
      expect(user!.preferences['language']).toBe('中文為主');
    });

    it('does nothing when user does not exist', async () => {
      // Should not throw
      await setPreference(999, 'key', 'value');
      const user = await getUser(999);
      expect(user).toBeUndefined();
    });
  });

  describe('getAllUsers()', () => {
    it('returns all users', async () => {
      await updateUser(1, { name: 'User1' });
      await updateUser(2, { name: 'User2' });

      const all = await getAllUsers();
      expect(Object.keys(all).length).toBe(2);
    });
  });

  describe('resetCache()', () => {
    it('is a no-op — SQLite is the source of truth', async () => {
      await updateUser(123, { name: 'Arc' });
      resetCache();

      // With SQLite backend, resetCache() is a no-op.
      // Data persists in the database, so the user is still available.
      const user = await getUser(123);
      expect(user).toBeDefined();
      expect(user!.name).toBe('Arc');
    });
  });
});
