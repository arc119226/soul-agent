import { readdir, readFile, stat, mkdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { logger } from '../core/logger.js';
import type { Bot } from 'grammy';

const SOUL_DIR = join(process.cwd(), 'soul');
const BACKUP_DIR = join(process.cwd(), 'data', 'backups');

/** Collect all files in a directory recursively */
async function collectFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await collectFiles(fullPath);
      files.push(...sub);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Create a simple tar-like archive (concatenated files with headers).
 * This produces a single .tar.gz file without needing external dependencies.
 */
async function createTarBuffer(baseDir: string, files: string[]): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for (const filePath of files) {
    const relPath = relative(baseDir, filePath).replace(/\\/g, '/');
    const content = await readFile(filePath);
    const s = await stat(filePath);

    // TAR header (512 bytes)
    const header = Buffer.alloc(512);

    // File name (0-100)
    header.write(relPath, 0, 100, 'utf-8');

    // File mode (100-108)
    header.write('0000644\0', 100, 8, 'utf-8');

    // Owner/group IDs (108-124) — zeros
    header.write('0000000\0', 108, 8, 'utf-8');
    header.write('0000000\0', 116, 8, 'utf-8');

    // File size in octal (124-136)
    header.write(s.size.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf-8');

    // Modification time in octal (136-148)
    const mtime = Math.floor(s.mtimeMs / 1000);
    header.write(mtime.toString(8).padStart(11, '0') + '\0', 136, 12, 'utf-8');

    // Checksum placeholder (148-156) — spaces
    header.write('        ', 148, 8, 'utf-8');

    // Type flag (156) — normal file
    header.write('0', 156, 1, 'utf-8');

    // USTAR indicator (257-263)
    header.write('ustar\0', 257, 6, 'utf-8');
    header.write('00', 263, 2, 'utf-8');

    // Calculate and write checksum
    let checksum = 0;
    for (let i = 0; i < 512; i++) {
      checksum += header[i]!;
    }
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf-8');

    chunks.push(header);
    chunks.push(content);

    // Pad to 512-byte boundary
    const remainder = content.length % 512;
    if (remainder > 0) {
      chunks.push(Buffer.alloc(512 - remainder));
    }
  }

  // End-of-archive marker (two 512-byte zero blocks)
  chunks.push(Buffer.alloc(1024));

  return Buffer.concat(chunks);
}

export async function backupSoul(
  bot: Bot,
  chatId: number,
): Promise<void> {
  await logger.info('SoulBackup', 'Starting soul backup');

  try {
    const files = await collectFiles(SOUL_DIR);
    if (files.length === 0) {
      await logger.warn('SoulBackup', 'No files found in soul/ directory');
      return;
    }

    const tarBuffer = await createTarBuffer(SOUL_DIR, files);

    // Gzip compress
    const gzipChunks: Buffer[] = [];
    const gzip = createGzip({ level: 9 });

    const input = Readable.from(tarBuffer);
    const collect = new (await import('node:stream')).Writable({
      write(chunk: Buffer, _encoding, callback) {
        gzipChunks.push(chunk);
        callback();
      },
    });

    await pipeline(input, gzip, collect);
    const gzipped = Buffer.concat(gzipChunks);

    // Save local backup
    await mkdir(BACKUP_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `soul-backup-${timestamp}.tar.gz`;
    const localPath = join(BACKUP_DIR, backupName);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(localPath, gzipped);

    // Send as Telegram document
    const inputFile = new (await import('grammy')).InputFile(gzipped, backupName);
    await bot.api.sendDocument(chatId, inputFile, {
      caption: `Soul backup — ${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}\n${files.length} files, ${(gzipped.length / 1024).toFixed(1)}KB`,
    });

    await logger.info(
      'SoulBackup',
      `Backup sent: ${backupName} (${files.length} files, ${gzipped.length} bytes)`,
    );
  } catch (err) {
    await logger.error('SoulBackup', `Backup failed: ${(err as Error).message}`);
    throw err;
  }
}
