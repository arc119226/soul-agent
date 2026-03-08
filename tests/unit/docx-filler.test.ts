import { describe, it, expect, vi } from 'vitest';

// We need to mock pizzip and docxtemplater before importing the module
let mockRenderedData: Record<string, unknown> = {};
let mockFullText = '{申請日期} {付款金額} {付款地址}';

vi.mock('pizzip', () => ({
  default: class MockPizZip {
    constructor() {}
  },
}));

vi.mock('docxtemplater', () => ({
  default: class MockDocxtemplater {
    constructor() {}
    getFullText() { return mockFullText; }
    render(data: Record<string, unknown>) { mockRenderedData = data; }
    getZip() {
      return {
        generate: () => Buffer.from('fake-docx-output'),
      };
    }
  },
}));

import { extractTemplateTags, fillDocxTemplate } from '../../src/documents/docx-filler.js';

describe('DOCX Filler', () => {
  describe('extractTemplateTags', () => {
    it('finds all {placeholder} tags', async () => {
      mockFullText = '申請人: {申請人}\n日期: {申請日期}\n金額: {付款金額}';
      const result = await extractTemplateTags(Buffer.from('fake'));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toEqual(['申請人', '申請日期', '付款金額']);
    });

    it('deduplicates repeated tags', async () => {
      mockFullText = '{name} and {name} again';
      const result = await extractTemplateTags(Buffer.from('fake'));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toEqual(['name']);
    });

    it('returns empty array when no tags found', async () => {
      mockFullText = 'No placeholders here';
      const result = await extractTemplateTags(Buffer.from('fake'));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toEqual([]);
    });
  });

  describe('fillDocxTemplate', () => {
    it('fills template with provided values', async () => {
      const values = {
        '申請日期': '2026/02/22',
        '付款金額': '$150.00',
        '付款地址': '123 Main St',
      };

      const result = await fillDocxTemplate(Buffer.from('fake-template'), values);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Verify render was called with correct values
      expect(mockRenderedData).toEqual(values);

      // Verify buffer output
      expect(Buffer.isBuffer(result.value)).toBe(true);
    });

    it('replaces undefined values with empty string', async () => {
      const values = {
        '申請日期': '2026/02/22',
        '付款金額': undefined,
      };

      const result = await fillDocxTemplate(Buffer.from('fake-template'), values);

      expect(result.ok).toBe(true);
      expect(mockRenderedData).toEqual({
        '申請日期': '2026/02/22',
        '付款金額': '',
      });
    });
  });
});
