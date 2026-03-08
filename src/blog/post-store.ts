/**
 * Post metadata store — CRUD for blog posts tracked in soul/blog/post-metadata.json
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writer } from '../core/debounced-writer.js';
import { logger } from '../core/logger.js';

const META_PATH = join(process.cwd(), 'soul', 'blog', 'post-metadata.json');

export interface PostMeta {
  slug: string;
  title: string;
  date: string;
  status: 'draft' | 'published';
  categories: string[];
  tags: string[];
  wordCount: number;
  createdBy: 'manual' | 'ai' | 'command';
  publishedAt?: string;
}

interface PostStore {
  posts: PostMeta[];
  stats: {
    totalPosts: number;
    totalDrafts: number;
    lastPublished: string;
  };
}

async function loadStore(): Promise<PostStore> {
  try {
    const raw = await readFile(META_PATH, 'utf-8');
    return JSON.parse(raw) as PostStore;
  } catch {
    return { posts: [], stats: { totalPosts: 0, totalDrafts: 0, lastPublished: '' } };
  }
}

async function saveStore(store: PostStore): Promise<void> {
  // Recompute stats
  store.stats.totalPosts = store.posts.filter(p => p.status === 'published').length;
  store.stats.totalDrafts = store.posts.filter(p => p.status === 'draft').length;
  const published = store.posts
    .filter(p => p.publishedAt)
    .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
  if (published.length > 0) {
    store.stats.lastPublished = published[0]!.publishedAt!;
  }
  writer.schedule(META_PATH, store);
}

/** Get all posts (optionally filtered by status) */
export async function getPosts(status?: 'draft' | 'published'): Promise<PostMeta[]> {
  const store = await loadStore();
  if (status) return store.posts.filter(p => p.status === status);
  return store.posts;
}

/** Get a specific post by slug */
export async function getPost(slug: string): Promise<PostMeta | undefined> {
  const store = await loadStore();
  return store.posts.find(p => p.slug === slug);
}

/** Add or update a post in the store */
export async function upsertPost(post: PostMeta): Promise<void> {
  const store = await loadStore();
  const idx = store.posts.findIndex(p => p.slug === post.slug);
  if (idx >= 0) {
    store.posts[idx] = post;
  } else {
    store.posts.push(post);
  }
  await saveStore(store);
  await logger.info('post-store', `Upserted post: ${post.slug} (${post.status})`);
}

/** Mark a draft as published */
export async function publishPost(slug: string): Promise<PostMeta | null> {
  const store = await loadStore();
  const post = store.posts.find(p => p.slug === slug);
  if (!post) return null;
  post.status = 'published';
  post.publishedAt = new Date().toISOString();
  await saveStore(store);
  await logger.info('post-store', `Published: ${slug}`);
  return post;
}

/** Get store stats */
export async function getPostStats(): Promise<PostStore['stats']> {
  const store = await loadStore();
  return store.stats;
}
