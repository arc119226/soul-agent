import { describe, it, expect, vi } from 'vitest';
import { parseDocument } from '../../src/documents/parsers.js';

// Mock pdf-parse (v2 class-based API)
vi.mock('pdf-parse', () => ({
  PDFParse: class MockPDFParse {
    async getText() {
      return {
        text: 'Invoice #12345\nAmount: $150.00\nAddress: 123 Main St',
        total: 2,
        pages: [],
      };
    }
    async destroy() {}
  },
}));

// Mock papaparse
vi.mock('papaparse', () => ({
  default: {
    parse: (_text: string, _opts: unknown) => ({
      data: [
        ['name', 'age', 'score'],
        ['Alice', 30, 95],
        ['Bob', 25, 82],
        ['Charlie', 35, 88],
      ],
      errors: [],
    }),
  },
}));

// Mock exceljs (ESM default export)
vi.mock('exceljs', () => ({
  default: {
    Workbook: class MockWorkbook {
      worksheets = [
        {
          name: 'Sheet1',
          eachRow: (cb: (row: { values: unknown[] }) => void) => {
            cb({ values: [undefined, 'col_a', 'col_b', 'col_c'] });
            cb({ values: [undefined, 'x', 10, 20] });
            cb({ values: [undefined, 'y', 30, 40] });
          },
        },
        { name: 'Sheet2', eachRow: () => {} },
      ];
      xlsx = {
        load: async () => {},
      };
    },
  },
}));

// Mock pizzip + docxtemplater for DOCX parsing
vi.mock('pizzip', () => ({
  default: class MockPizZip {
    constructor() {}
  },
}));

vi.mock('docxtemplater', () => ({
  default: class MockDocxtemplater {
    constructor() {}
    getFullText() { return '申請日期: {申請日期}\n付款金額: {付款金額}'; }
  },
}));

describe('parseDocument', () => {
  describe('PDF parser', () => {
    it('extracts text and page count', async () => {
      const buffer = Buffer.from('fake-pdf-data');
      const result = await parseDocument('pdf', buffer, 'invoice.pdf');

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.type).toBe('pdf');
      expect(result.value.fileName).toBe('invoice.pdf');
      expect(result.value.textContent).toContain('Invoice #12345');
      expect(result.value.textContent).toContain('$150.00');
      expect(result.value.meta.pageCount).toBe(2);
    });
  });

  describe('CSV parser', () => {
    it('extracts headers, rows, and computes stats', async () => {
      const csv = 'name,age,score\nAlice,30,95\nBob,25,82\nCharlie,35,88';
      const buffer = Buffer.from(csv);
      const result = await parseDocument('csv', buffer, 'data.csv');

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.type).toBe('csv');
      expect(result.value.meta.rowCount).toBe(3);
      expect(result.value.meta.columnCount).toBe(3);
      expect(result.value.meta.columnNames).toEqual(['name', 'age', 'score']);
      expect(result.value.textContent).toContain('data.csv');
      expect(result.value.textContent).toContain('3 行');
    });
  });

  describe('XLSX parser', () => {
    it('extracts sheet names and data', async () => {
      const buffer = Buffer.from('fake-xlsx');
      const result = await parseDocument('xlsx', buffer, 'report.xlsx');

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.type).toBe('xlsx');
      expect(result.value.meta.sheetNames).toEqual(['Sheet1', 'Sheet2']);
      expect(result.value.meta.rowCount).toBe(2);
      expect(result.value.meta.columnCount).toBe(3);
      expect(result.value.textContent).toContain('report.xlsx');
    });
  });

  describe('DOCX parser', () => {
    it('extracts text content', async () => {
      const buffer = Buffer.from('fake-docx');
      const result = await parseDocument('docx', buffer, 'form.docx');

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.type).toBe('docx');
      expect(result.value.textContent).toContain('申請日期');
      expect(result.value.textContent).toContain('付款金額');
    });
  });
});
