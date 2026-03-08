/**
 * Downloads files from Telegram servers.
 * Uses bot.api.getFile() → HTTPS GET with IPv4 from Telegram CDN.
 */

import { mkdirSync } from 'node:fs';
import { get as httpsGet } from 'node:https';
import type { Bot } from 'grammy';
import type { BotContext } from '../bot.js';
import { ok, fail, type Result } from '../result.js';
import { DOC_CONFIG, MIME_MAP, EXT_MAP, type SupportedDocType } from './types.js';

// Ensure upload directory exists
try { mkdirSync(DOC_CONFIG.UPLOAD_DIR, { recursive: true }); } catch { /* ignore */ }

export interface DownloadedFile {
  buffer: Buffer;
  fileName: string;
  docType: SupportedDocType;
  fileSizeBytes: number;
}

/**
 * Detect document type from MIME type + file extension.
 */
export function detectDocType(mimeType?: string, fileName?: string): Result<SupportedDocType> {
  // Try MIME type first
  if (mimeType && MIME_MAP[mimeType]) {
    return ok('MIME matched', MIME_MAP[mimeType]);
  }

  // Fallback to file extension
  if (fileName) {
    const ext = fileName.substring(fileName.lastIndexOf('.')).toLowerCase();
    if (EXT_MAP[ext]) {
      return ok('Extension matched', EXT_MAP[ext]);
    }
  }

  return fail(
    `不支援的檔案格式${mimeType ? ` (${mimeType})` : ''}`,
    '目前支援 PDF、DOCX、CSV、XLSX',
  );
}

/** HTTPS GET with forced IPv4 (matches bot.ts IPv4 config for WSL2 compatibility) */
function downloadBufferIPv4(url: string, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error('TIMEOUT'));
    }, timeoutMs);

    const req = httpsGet(url, { family: 4 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        clearTimeout(timer);
        downloadBufferIPv4(res.headers.location, timeoutMs).then(resolve, reject);
        return;
      }
      if (!res.statusCode || res.statusCode !== 200) {
        clearTimeout(timer);
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
      res.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
    req.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

/**
 * Download a file from Telegram and return its buffer.
 */
export async function downloadTelegramFile(
  bot: Bot<BotContext>,
  fileId: string,
  fileName: string,
  mimeType?: string,
): Promise<Result<DownloadedFile>> {
  // 1. Detect type
  const typeResult = detectDocType(mimeType, fileName);
  if (!typeResult.ok) return typeResult;

  // 2. Get file info from Telegram
  let filePath: string;
  try {
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) {
      return fail('Telegram 未回傳檔案路徑');
    }
    filePath = file.file_path;
  } catch (err) {
    return fail(`取得檔案資訊失敗: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Download binary from Telegram CDN (force IPv4 — WSL2 IPv6 is broken)
  const url = `https://api.telegram.org/file/bot${bot.token}/${filePath}`;

  try {
    const buffer = await downloadBufferIPv4(url, DOC_CONFIG.DOWNLOAD_TIMEOUT_MS);

    // 4. Size validation
    if (buffer.length > DOC_CONFIG.MAX_FILE_SIZE) {
      return fail(
        `檔案太大 (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`,
        `上限 ${DOC_CONFIG.MAX_FILE_SIZE / 1024 / 1024}MB`,
      );
    }

    return ok('下載完成', {
      buffer,
      fileName,
      docType: typeResult.value,
      fileSizeBytes: buffer.length,
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'TIMEOUT') {
      return fail('下載超時', `超過 ${DOC_CONFIG.DOWNLOAD_TIMEOUT_MS / 1000} 秒`);
    }
    return fail(`下載失敗: ${err instanceof Error ? err.message : String(err)}`);
  }
}
