import { describe, it, expect } from 'vitest';
import { detectDocType } from '../../src/documents/file-downloader.js';

describe('detectDocType', () => {
  it('detects PDF by MIME type', () => {
    const result = detectDocType('application/pdf', 'invoice.pdf');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('pdf');
  });

  it('detects CSV by MIME type', () => {
    const result = detectDocType('text/csv', 'data.csv');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('csv');
  });

  it('detects XLSX by MIME type', () => {
    const result = detectDocType(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'report.xlsx',
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('xlsx');
  });

  it('detects DOCX by MIME type', () => {
    const result = detectDocType(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'form.docx',
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('docx');
  });

  it('detects XLS as xlsx', () => {
    const result = detectDocType('application/vnd.ms-excel', 'old.xls');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('xlsx');
  });

  it('falls back to extension when MIME is unknown', () => {
    const result = detectDocType('application/octet-stream', 'data.csv');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('csv');
  });

  it('falls back to extension when MIME is missing', () => {
    const result = detectDocType(undefined, 'report.xlsx');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('xlsx');
  });

  it('rejects unsupported types', () => {
    const result = detectDocType('application/zip', 'archive.zip');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不支援');
      expect(result.fixHint).toContain('PDF');
    }
  });

  it('rejects when both MIME and extension are unknown', () => {
    const result = detectDocType(undefined, 'mystery');
    expect(result.ok).toBe(false);
  });
});
