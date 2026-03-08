/**
 * Hexo CLI wrapper — create drafts, generate, and manage the Hexo blog.
 *
 * Uses execFile (not exec) to avoid shell injection — arguments are passed
 * as an array, never concatenated into a shell command string.
 */

import { readFile, writeFile, readdir, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../core/logger.js';

const execFileAsync = promisify(execFile);
const BLOG_DIR = join(process.cwd(), 'blog');
const DRAFTS_DIR = join(BLOG_DIR, 'source', '_drafts');
const POSTS_DIR = join(BLOG_DIR, 'source', '_posts');

export interface HexoResult {
  ok: boolean;
  message: string;
  slug?: string;
  path?: string;
}

/** Convert title to URL-safe slug */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff\u3400-\u4dbf-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Create a new draft post */
export async function createDraft(
  title: string,
  content: string,
  opts?: { categories?: string[]; tags?: string[] },
): Promise<HexoResult> {
  const slug = slugify(title);
  const fileName = `${slug}.md`;
  const filePath = join(DRAFTS_DIR, fileName);

  // Build front matter
  const frontMatter = [
    '---',
    `title: "${title}"`,
    `date: ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
  ];
  if (opts?.categories?.length) {
    frontMatter.push('categories:');
    opts.categories.forEach(c => frontMatter.push(`  - ${c}`));
  }
  if (opts?.tags?.length) {
    frontMatter.push('tags:');
    opts.tags.forEach(t => frontMatter.push(`  - ${t}`));
  }
  frontMatter.push('---', '', content);

  try {
    await writeFile(filePath, frontMatter.join('\n'), 'utf-8');
    await logger.info('hexo-manager', `Created draft: ${slug}`);
    return { ok: true, message: `草稿已建立: ${slug}`, slug, path: filePath };
  } catch (err) {
    const msg = `建立草稿失敗: ${(err as Error).message}`;
    await logger.error('hexo-manager', msg);
    return { ok: false, message: msg };
  }
}

/** Move a draft to posts (publish) */
export async function moveDraftToPost(slug: string): Promise<HexoResult> {
  const draftPath = join(DRAFTS_DIR, `${slug}.md`);
  const postPath = join(POSTS_DIR, `${slug}.md`);

  try {
    const content = await readFile(draftPath, 'utf-8');
    await writeFile(postPath, content, 'utf-8');
    await unlink(draftPath);
    await logger.info('hexo-manager', `Moved draft to post: ${slug}`);
    return { ok: true, message: `已發布: ${slug}`, slug, path: postPath };
  } catch (err) {
    const msg = `發布失敗: ${(err as Error).message}`;
    await logger.error('hexo-manager', msg);
    return { ok: false, message: msg };
  }
}

/** Run hexo generate (uses execFile — no shell injection risk) */
export async function generate(): Promise<HexoResult> {
  try {
    const { stdout } = await execFileAsync('npx', ['hexo', 'generate'], {
      cwd: BLOG_DIR,
      timeout: 60_000,
    });
    const fileCount = (stdout.match(/Generated:/g) ?? []).length;
    await logger.info('hexo-manager', `Generated ${fileCount} files`);
    return { ok: true, message: `生成完成: ${fileCount} 個檔案` };
  } catch (err) {
    const msg = `生成失敗: ${(err as Error).message}`;
    await logger.error('hexo-manager', msg);
    return { ok: false, message: msg };
  }
}

/** List drafts */
export async function listDrafts(): Promise<string[]> {
  try {
    const files = await readdir(DRAFTS_DIR);
    return files.filter(f => f.endsWith('.md')).map(f => f.replace('.md', ''));
  } catch {
    return [];
  }
}

/** List published posts (from file system, sorted by modification time descending) */
export async function listPosts(): Promise<string[]> {
  try {
    const files = await readdir(POSTS_DIR);
    const mdFiles = files.filter(f => f.endsWith('.md'));

    // Get modification times for sorting
    const withStats = await Promise.all(
      mdFiles.map(async f => {
        try {
          const s = await stat(join(POSTS_DIR, f));
          return { name: f, mtime: s.mtimeMs };
        } catch {
          return { name: f, mtime: 0 };
        }
      })
    );

    // Sort by modification time descending (newest first)
    withStats.sort((a, b) => b.mtime - a.mtime);
    return withStats.map(f => f.name.replace('.md', ''));
  } catch {
    return [];
  }
}

/** Read a draft or post content */
export async function readPost(slug: string): Promise<string | null> {
  for (const dir of [DRAFTS_DIR, POSTS_DIR]) {
    try {
      return await readFile(join(dir, `${slug}.md`), 'utf-8');
    } catch {
      continue;
    }
  }
  return null;
}
