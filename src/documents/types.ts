/**
 * Document processing types and configuration constants.
 */

import { join } from 'node:path';

export type SupportedDocType = 'pdf' | 'csv' | 'xlsx' | 'docx';

export interface ParsedDocument {
  type: SupportedDocType;
  fileName: string;
  /** Extracted text content (for passing to Claude) */
  textContent: string;
  /** Raw buffer of the original file */
  buffer: Buffer;
  meta: DocumentMeta;
}

export interface DocumentMeta {
  pageCount?: number;       // PDF
  rowCount?: number;        // CSV/XLSX
  columnCount?: number;     // CSV/XLSX
  columnNames?: string[];   // CSV/XLSX
  sheetNames?: string[];    // XLSX
  fileSizeBytes: number;
  parseTimeMs: number;
}

/** Files buffered in a media group (multi-file upload) */
export interface FileGroup {
  chatId: number;
  userId: number;
  caption?: string;
  files: ParsedDocument[];
  timer: ReturnType<typeof setTimeout>;
}

export const DOC_CONFIG = {
  /** Max file size for download (Telegram limit) */
  MAX_FILE_SIZE: 20 * 1024 * 1024,
  /** Max text content chars to pass to Claude */
  MAX_CONTENT_LENGTH: 50_000,
  /** Max sample rows for spreadsheet summary */
  MAX_SAMPLE_ROWS: 20,
  /** Upload directory (transient) */
  UPLOAD_DIR: join(process.cwd(), 'data', 'uploads'),
  /** Download timeout */
  DOWNLOAD_TIMEOUT_MS: 30_000,
  /** Media group buffer timeout — wait for all files to arrive */
  MEDIA_GROUP_TIMEOUT_MS: 3_000,
} as const;

/** MIME type → SupportedDocType mapping */
export const MIME_MAP: Record<string, SupportedDocType> = {
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'application/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

/** Extension fallback for MIME detection */
export const EXT_MAP: Record<string, SupportedDocType> = {
  '.pdf': 'pdf',
  '.csv': 'csv',
  '.xlsx': 'xlsx',
  '.xls': 'xlsx',
  '.docx': 'docx',
};
