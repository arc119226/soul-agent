import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: { ADMIN_USER_ID: 12345 },
}));

import { buildMainMenu, CATEGORIES } from '../../src/commands/menu.js';

/** Extract callback_data from an InlineKeyboardButton (union type). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getCallbackData(btn: any): string | undefined {
  return btn.callback_data as string | undefined;
}

describe('menu', () => {
  describe('CATEGORIES', () => {
    it('has 7 categories', () => {
      expect(CATEGORIES).toHaveLength(7);
    });

    it('each category has required fields', () => {
      for (const cat of CATEGORIES) {
        expect(cat.key).toBeTruthy();
        expect(cat.icon).toBeTruthy();
        expect(cat.label).toBeTruthy();
        expect(typeof cat.adminOnly).toBe('boolean');
        expect(cat.commands.length).toBeGreaterThan(0);
      }
    });

    it('each command has required fields', () => {
      for (const cat of CATEGORIES) {
        for (const cmd of cat.commands) {
          expect(cmd.icon).toBeTruthy();
          expect(cmd.label).toBeTruthy();
          expect(cmd.command).toBeTruthy();
          // command should be a valid identifier (no spaces or special chars)
          expect(cmd.command).toMatch(/^[a-z]+$/);
        }
      }
    });

    it('has unique category keys', () => {
      const keys = CATEGORIES.map(c => c.key);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('has no duplicate commands across categories', () => {
      const allCommands = CATEGORIES.flatMap(c => c.commands.map(cmd => cmd.command));
      expect(new Set(allCommands).size).toBe(allCommands.length);
    });

    it('covers expected category keys', () => {
      const keys = new Set(CATEGORIES.map(c => c.key));
      expect(keys).toContain('status');
      expect(keys).toContain('operations');
      expect(keys).toContain('content');
      expect(keys).toContain('soul');
      expect(keys).toContain('agents');
      expect(keys).toContain('dev');
      expect(keys).toContain('system');
    });

    it('has 4 public and 3 admin-only categories', () => {
      const publicCats = CATEGORIES.filter(c => !c.adminOnly);
      const adminCats = CATEGORIES.filter(c => c.adminOnly);
      expect(publicCats).toHaveLength(4);
      expect(adminCats).toHaveLength(3);
    });
  });

  describe('buildMainMenu', () => {
    it('returns an InlineKeyboard', () => {
      const kb = buildMainMenu(true);
      expect(kb).toBeDefined();
      expect(Array.isArray(kb.inline_keyboard)).toBe(true);
    });

    it('admin menu produces 4 rows for 7 categories (2 per row)', () => {
      const kb = buildMainMenu(true);
      expect(kb.inline_keyboard).toHaveLength(4);
    });

    it('non-admin menu produces 2 rows for 4 public categories', () => {
      const kb = buildMainMenu(false);
      expect(kb.inline_keyboard).toHaveLength(2);
    });

    it('each row has at most 2 buttons', () => {
      const kb = buildMainMenu(true);
      for (const row of kb.inline_keyboard) {
        expect(row.length).toBeLessThanOrEqual(2);
      }
    });

    it('all buttons have menu:cat: callback data', () => {
      const kb = buildMainMenu(true);
      for (const row of kb.inline_keyboard) {
        for (const btn of row) {
          expect(getCallbackData(btn as any)).toMatch(/^menu:cat:\w+$/);
        }
      }
    });

    it('admin menu contains all category labels', () => {
      const kb = buildMainMenu(true);
      const allLabels = kb.inline_keyboard.flat().map(b => b.text);
      for (const cat of CATEGORIES) {
        const found = allLabels.some(label => label.includes(cat.label));
        expect(found).toBe(true);
      }
    });

    it('non-admin menu only shows public category labels', () => {
      const kb = buildMainMenu(false);
      const allLabels = kb.inline_keyboard.flat().map(b => b.text);
      const publicCats = CATEGORIES.filter(c => !c.adminOnly);
      const adminCats = CATEGORIES.filter(c => c.adminOnly);

      for (const cat of publicCats) {
        const found = allLabels.some(label => label.includes(cat.label));
        expect(found).toBe(true);
      }
      for (const cat of adminCats) {
        const found = allLabels.some(label => label.includes(cat.label));
        expect(found).toBe(false);
      }
    });
  });

  describe('callback data format', () => {
    it('admin menu callback_data matches all category keys', () => {
      const kb = buildMainMenu(true);
      const callbackKeys = kb.inline_keyboard
        .flat()
        .map(b => getCallbackData(b as any)!.replace('menu:cat:', ''));
      const catKeys = CATEGORIES.map(c => c.key);
      expect(callbackKeys.sort()).toEqual(catKeys.sort());
    });

    it('non-admin menu callback_data matches public category keys', () => {
      const kb = buildMainMenu(false);
      const callbackKeys = kb.inline_keyboard
        .flat()
        .map(b => getCallbackData(b as any)!.replace('menu:cat:', ''));
      const publicKeys = CATEGORIES.filter(c => !c.adminOnly).map(c => c.key);
      expect(callbackKeys.sort()).toEqual(publicKeys.sort());
    });

    it('callback_data for Telegram is under 64 bytes', () => {
      const kb = buildMainMenu(true);
      for (const row of kb.inline_keyboard) {
        for (const btn of row) {
          const bytes = Buffer.byteLength(btn.callback_data!, 'utf8');
          expect(bytes).toBeLessThanOrEqual(64);
        }
      }

      for (const cat of CATEGORIES) {
        for (const cmd of cat.commands) {
          const data = `menu:cmd:${cmd.command}`;
          const bytes = Buffer.byteLength(data, 'utf8');
          expect(bytes).toBeLessThanOrEqual(64);
        }
      }
    });
  });
});
