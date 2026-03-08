/**
 * Document parsers — extract text content from PDF, CSV, XLSX files.
 * Each parser returns a ParsedDocument with human-readable textContent
 * suitable for passing to Claude as context.
 */

import { ok, fail, type Result } from '../result.js';
import { DOC_CONFIG, type ParsedDocument, type SupportedDocType } from './types.js';

// ── PDF Parser ──────────────────────────────────────────────────────

async function parsePdf(buffer: Buffer, fileName: string): Promise<Result<ParsedDocument>> {
  const start = Date.now();
  try {
    const { PDFParse } = await import('pdf-parse');
    const pdf = new PDFParse({ data: new Uint8Array(buffer) });
    const textResult = await pdf.getText();
    await pdf.destroy();

    let text = textResult.text || '';
    if (text.length > DOC_CONFIG.MAX_CONTENT_LENGTH) {
      text = text.slice(0, DOC_CONFIG.MAX_CONTENT_LENGTH) + '\n\n[... 內容已截斷 ...]';
    }

    return ok('PDF parsed', {
      type: 'pdf' as const,
      fileName,
      textContent: text,
      buffer,
      meta: {
        pageCount: textResult.total,
        fileSizeBytes: buffer.length,
        parseTimeMs: Date.now() - start,
      },
    });
  } catch (err) {
    return fail(
      `PDF 解析失敗: ${err instanceof Error ? err.message : String(err)}`,
      '請確認檔案未損壞或加密',
    );
  }
}

// ── CSV Parser ──────────────────────────────────────────────────────

async function parseCsv(buffer: Buffer, fileName: string): Promise<Result<ParsedDocument>> {
  const start = Date.now();
  try {
    const Papa = (await import('papaparse')).default;
    const text = buffer.toString('utf-8');
    const result = Papa.parse<string[]>(text, {
      header: false,
      skipEmptyLines: true,
      dynamicTyping: true,
    });

    if (result.errors.length > 0 && result.data.length === 0) {
      return fail(`CSV 解析錯誤: ${result.errors[0]?.message || '未知錯誤'}`);
    }

    const rows = result.data;
    if (rows.length === 0) {
      return fail('CSV 檔案為空');
    }

    // First row as headers
    const headers = rows[0]?.map(String) ?? [];
    const dataRows = rows.slice(1);
    const summary = buildSpreadsheetSummary(headers, dataRows, fileName);

    return ok('CSV parsed', {
      type: 'csv' as const,
      fileName,
      textContent: summary,
      buffer,
      meta: {
        rowCount: dataRows.length,
        columnCount: headers.length,
        columnNames: headers,
        fileSizeBytes: buffer.length,
        parseTimeMs: Date.now() - start,
      },
    });
  } catch (err) {
    return fail(`CSV 解析失敗: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── XLSX Parser ─────────────────────────────────────────────────────

async function parseXlsx(buffer: Buffer, fileName: string): Promise<Result<ParsedDocument>> {
  const start = Date.now();
  try {
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

    const sheetNames = workbook.worksheets.map((ws) => ws.name);
    if (sheetNames.length === 0) {
      return fail('XLSX 沒有工作表');
    }

    // Parse first sheet
    const sheet = workbook.worksheets[0]!;
    const rows: unknown[][] = [];
    sheet.eachRow((row) => {
      rows.push(row.values as unknown[]);
    });

    if (rows.length === 0) {
      return fail('XLSX 工作表為空');
    }

    // First row as headers (ExcelJS row.values index starts at 1, position 0 is undefined)
    const rawHeaders = rows[0]!;
    const headers = rawHeaders.slice(1).map(String);
    const dataRows = rows.slice(1).map((r) => r.slice(1));
    const summary = buildSpreadsheetSummary(headers, dataRows, fileName, sheetNames);

    return ok('XLSX parsed', {
      type: 'xlsx' as const,
      fileName,
      textContent: summary,
      buffer,
      meta: {
        rowCount: dataRows.length,
        columnCount: headers.length,
        columnNames: headers,
        sheetNames,
        fileSizeBytes: buffer.length,
        parseTimeMs: Date.now() - start,
      },
    });
  } catch (err) {
    return fail(`XLSX 解析失敗: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── DOCX Text Extraction ────────────────────────────────────────────

async function parseDocx(buffer: Buffer, fileName: string): Promise<Result<ParsedDocument>> {
  const start = Date.now();
  try {
    const PizZip = (await import('pizzip')).default;
    const Docxtemplater = (await import('docxtemplater')).default;

    const zip = new PizZip(buffer);
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      delimiters: { start: '{', end: '}' },
    });

    // Extract full text (preserving structure)
    const text = doc.getFullText();

    return ok('DOCX parsed', {
      type: 'docx' as const,
      fileName,
      textContent: text,
      buffer,
      meta: {
        fileSizeBytes: buffer.length,
        parseTimeMs: Date.now() - start,
      },
    });
  } catch (err) {
    return fail(`DOCX 解析失敗: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Spreadsheet Summary Builder ─────────────────────────────────────

function buildSpreadsheetSummary(
  headers: string[],
  dataRows: unknown[][],
  fileName: string,
  sheetNames?: string[],
): string {
  const lines: string[] = [];

  lines.push(`📊 ${fileName}`);
  if (sheetNames && sheetNames.length > 1) {
    lines.push(`工作表：${sheetNames.join(', ')}（分析第一個）`);
  }
  lines.push(`資料：${dataRows.length} 行 × ${headers.length} 欄`);
  lines.push(`欄位：${headers.join(', ')}`);
  lines.push('');

  // Sample rows (first N)
  const sampleCount = Math.min(dataRows.length, DOC_CONFIG.MAX_SAMPLE_ROWS);
  lines.push(`--- 前 ${sampleCount} 行取樣 ---`);

  // Header row
  lines.push(headers.join('\t'));

  for (let i = 0; i < sampleCount; i++) {
    const row = dataRows[i];
    if (row) {
      lines.push(row.map((cell) => (cell == null ? '' : String(cell))).join('\t'));
    }
  }

  if (dataRows.length > sampleCount) {
    lines.push(`... 還有 ${dataRows.length - sampleCount} 行`);
  }
  lines.push('');

  // Basic stats for numeric columns
  const numericStats = computeNumericStats(headers, dataRows);
  if (numericStats.length > 0) {
    lines.push('--- 數值欄位統計 ---');
    for (const stat of numericStats) {
      lines.push(`${stat.column}: min=${stat.min}, max=${stat.max}, avg=${stat.avg.toFixed(2)}, count=${stat.count}`);
    }
  }

  return lines.join('\n');
}

interface ColumnStats {
  column: string;
  min: number;
  max: number;
  avg: number;
  count: number;
}

function computeNumericStats(headers: string[], dataRows: unknown[][]): ColumnStats[] {
  const stats: ColumnStats[] = [];

  for (let col = 0; col < headers.length; col++) {
    const values: number[] = [];
    for (const row of dataRows) {
      const val = row?.[col];
      if (typeof val === 'number' && !isNaN(val)) {
        values.push(val);
      }
    }

    // Only report if at least 30% of values are numeric
    if (values.length >= dataRows.length * 0.3 && values.length > 0) {
      const min = Math.min(...values);
      const max = Math.max(...values);
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      stats.push({ column: headers[col]!, min, max, avg, count: values.length });
    }
  }

  return stats;
}

// ── Router ──────────────────────────────────────────────────────────

export async function parseDocument(
  type: SupportedDocType,
  buffer: Buffer,
  fileName: string,
): Promise<Result<ParsedDocument>> {
  switch (type) {
    case 'pdf': return parsePdf(buffer, fileName);
    case 'csv': return parseCsv(buffer, fileName);
    case 'xlsx': return parseXlsx(buffer, fileName);
    case 'docx': return parseDocx(buffer, fileName);
  }
}
