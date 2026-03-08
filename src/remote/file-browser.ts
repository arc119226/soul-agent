import { readdir, readFile as fsReadFile, writeFile as fsWriteFile, stat } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { InlineKeyboard } from 'grammy';
import type { BotContext } from '../bot.js';
import { logger } from '../core/logger.js';
import { ok, fail, type Result } from '../result.js';
import { config } from '../config.js';

const MODULE = 'file-browser';

/** Max file content length for Telegram messages */
const MAX_FILE_CONTENT = 4000;
/** Max number of entries to show in a listing */
const MAX_ENTRIES = 30;

/** Allowed base directories for browsing */
function getAllowedBases(): string[] {
  const cwd = config.CLAUDE_CODE_CWD || process.cwd();
  return [resolve(cwd)];
}

/** Check if a path is within allowed directories */
function isPathAllowed(targetPath: string): boolean {
  const resolved = resolve(targetPath);
  return getAllowedBases().some((base) => resolved.startsWith(base));
}

export interface FileEntry {
  name: string;
  isDirectory: boolean;
  size: number;
}

export interface DirectoryListing {
  path: string;
  entries: FileEntry[];
  keyboard: InlineKeyboard;
}

/** List directory contents with inline keyboard navigation */
export async function listDirectory(path?: string): Promise<Result<DirectoryListing>> {
  const targetPath = resolve(path || getAllowedBases()[0] || process.cwd());

  if (!isPathAllowed(targetPath)) {
    return fail(`Access denied: path outside allowed directories`, 'Use a path within the project directory');
  }

  try {
    const dirStat = await stat(targetPath);
    if (!dirStat.isDirectory()) {
      return fail(`Not a directory: ${targetPath}`);
    }

    const items = await readdir(targetPath, { withFileTypes: true });
    const entries: FileEntry[] = [];

    for (const item of items.slice(0, MAX_ENTRIES)) {
      try {
        const fullPath = join(targetPath, item.name);
        const s = await stat(fullPath);
        entries.push({
          name: item.name,
          isDirectory: item.isDirectory(),
          size: s.size,
        });
      } catch {
        entries.push({
          name: item.name,
          isDirectory: item.isDirectory(),
          size: 0,
        });
      }
    }

    // Sort: directories first, then alphabetical
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const keyboard = buildKeyboard(targetPath, entries);

    return ok('Directory listed', { path: targetPath, entries, keyboard });
  } catch (err) {
    logger.error(MODULE, `Failed to list directory: ${targetPath}`, err);
    return fail(`Failed to list directory: ${(err as Error).message}`);
  }
}

/** Read file content, truncated for Telegram */
export async function readFileContent(path: string): Promise<Result<string>> {
  const targetPath = resolve(path);

  if (!isPathAllowed(targetPath)) {
    return fail('Access denied: path outside allowed directories');
  }

  try {
    const s = await stat(targetPath);
    if (s.isDirectory()) {
      return fail('Cannot read a directory. Use listDirectory instead.');
    }

    if (s.size > 1024 * 1024) {
      return fail(`File too large: ${(s.size / 1024 / 1024).toFixed(1)}MB (max 1MB)`);
    }

    let content = await fsReadFile(targetPath, 'utf-8');
    let truncated = false;

    if (content.length > MAX_FILE_CONTENT) {
      content = content.slice(0, MAX_FILE_CONTENT);
      truncated = true;
    }

    const header = `File: ${basename(targetPath)}\n${'─'.repeat(30)}\n`;
    const footer = truncated ? `\n\n... (truncated, ${s.size} bytes total)` : '';

    return ok('File read', header + content + footer);
  } catch (err) {
    logger.error(MODULE, `Failed to read file: ${targetPath}`, err);
    return fail(`Failed to read file: ${(err as Error).message}`);
  }
}

/** Write content to a file */
export async function writeFileContent(path: string, content: string): Promise<Result<string>> {
  const targetPath = resolve(path);

  if (!isPathAllowed(targetPath)) {
    return fail('Access denied: path outside allowed directories');
  }

  try {
    await fsWriteFile(targetPath, content, 'utf-8');
    logger.info(MODULE, `File written: ${targetPath}`);
    return ok('File written', `Successfully wrote ${content.length} bytes to ${basename(targetPath)}`);
  } catch (err) {
    logger.error(MODULE, `Failed to write file: ${targetPath}`, err);
    return fail(`Failed to write file: ${(err as Error).message}`);
  }
}

/** Format directory listing as readable text */
export function formatListing(listing: DirectoryListing): string {
  const lines: string[] = [`*Directory:* \`${listing.path}\``, ''];

  if (listing.entries.length === 0) {
    lines.push('(empty directory)');
    return lines.join('\n');
  }

  for (const entry of listing.entries) {
    const icon = entry.isDirectory ? '📁' : '📄';
    const size = entry.isDirectory ? '' : ` (${formatSize(entry.size)})`;
    lines.push(`${icon} \`${entry.name}\`${size}`);
  }

  return lines.join('\n');
}

/** Build inline keyboard for directory navigation */
function buildKeyboard(currentPath: string, entries: FileEntry[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  // Parent directory button
  const parent = dirname(currentPath);
  if (parent !== currentPath && isPathAllowed(parent)) {
    keyboard.text('⬆️ Parent Directory', `fb:dir:${parent}`).row();
  }

  // Subdirectories as buttons (max 10)
  const dirs = entries.filter((e) => e.isDirectory).slice(0, 10);
  for (const dir of dirs) {
    const fullPath = join(currentPath, dir.name);
    keyboard.text(`📁 ${dir.name}`, `fb:dir:${fullPath}`).row();
  }

  // Files as buttons (max 5)
  const files = entries.filter((e) => !e.isDirectory).slice(0, 5);
  for (const file of files) {
    const fullPath = join(currentPath, file.name);
    keyboard.text(`📄 ${file.name}`, `fb:file:${fullPath}`).row();
  }

  return keyboard;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** Handle callback queries for file browser */
export async function handleFileBrowserCallback(
  ctx: BotContext,
  data: string,
): Promise<void> {
  if (data.startsWith('dir:')) {
    const dirPath = data.slice(4);
    const result = await listDirectory(dirPath);
    if (result.ok) {
      const text = formatListing(result.value);
      try {
        await ctx.editMessageText(text, {
          parse_mode: 'Markdown',
          reply_markup: result.value.keyboard,
        });
      } catch {
        await ctx.reply(text, {
          parse_mode: 'Markdown',
          reply_markup: result.value.keyboard,
        });
      }
    } else {
      await ctx.reply(`Error: ${result.error}`);
    }
  } else if (data.startsWith('file:')) {
    const filePath = data.slice(5);
    const result = await readFileContent(filePath);
    if (result.ok) {
      await ctx.reply(`\`\`\`\n${result.value}\n\`\`\``, { parse_mode: 'Markdown' });
    } else {
      await ctx.reply(`Error: ${result.error}`);
    }
  }
}
