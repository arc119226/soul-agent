/**
 * In-memory BM25 inverted index for fast memory retrieval.
 * Builds from soul/ data sources at startup, incrementally updated via EventBus.
 * JSON remains source of truth — index is a pure derived in-memory structure.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tailReadJsonl } from '../core/tail-read.js';
import { eventBus } from '../core/event-bus.js';
import { logger } from '../core/logger.js';
import { tokenize } from './text-relevance.js';

// BM25 parameters
const K1 = 1.2;
const B = 0.75;

export interface IndexDocument {
  id: string;
  source: 'topic' | 'decision' | 'event' | 'narrative' | 'fact' | 'learning' | 'compressed';
  text: string;
  tokens: string[];
  metadata?: Record<string, unknown>;
}

interface PostingEntry {
  docId: string;
  tf: number; // term frequency in this document
}

class MemorySearchIndex {
  private documents = new Map<string, IndexDocument>();
  private invertedIndex = new Map<string, Map<string, PostingEntry>>();
  private docLengths = new Map<string, number>();
  private avgDocLength = 0;
  private totalDocs = 0;
  private totalDocLength = 0;
  private initialized = false;

  /** Add or update a document in the index */
  upsert(doc: IndexDocument): void {
    const isUpdate = this.documents.has(doc.id);
    // Remove old version if exists
    if (isUpdate) {
      this.removeFromInverted(doc.id);
    }

    this.documents.set(doc.id, doc);

    // Build token frequency map
    const tfMap = new Map<string, number>();
    for (const token of doc.tokens) {
      tfMap.set(token, (tfMap.get(token) ?? 0) + 1);
    }

    // Update inverted index
    for (const [token, tf] of tfMap) {
      if (!this.invertedIndex.has(token)) {
        this.invertedIndex.set(token, new Map());
      }
      this.invertedIndex.get(token)!.set(doc.id, { docId: doc.id, tf });
    }

    // Incrementally update doc length stats
    const oldLen = this.docLengths.get(doc.id) ?? 0;
    const newLen = doc.tokens.length;
    this.totalDocLength += newLen - oldLen;
    this.docLengths.set(doc.id, newLen);
    if (!isUpdate) this.totalDocs++;
    this.avgDocLength = this.totalDocs > 0 ? this.totalDocLength / this.totalDocs : 0;
  }

  /** Remove a document from the index */
  remove(id: string): void {
    if (!this.documents.has(id)) return;
    this.removeFromInverted(id);
    this.documents.delete(id);
    const oldLen = this.docLengths.get(id) ?? 0;
    this.docLengths.delete(id);
    this.totalDocLength -= oldLen;
    this.totalDocs--;
    this.avgDocLength = this.totalDocs > 0 ? this.totalDocLength / this.totalDocs : 0;
  }

  /** BM25 search — returns top results sorted by score */
  search(query: string, limit: number = 10): Array<{ doc: IndexDocument; score: number }> {
    if (this.totalDocs === 0) return [];

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    // Deduplicate query tokens
    const uniqueTokens = [...new Set(queryTokens)];

    // Accumulate BM25 scores per document
    const scores = new Map<string, number>();

    for (const token of uniqueTokens) {
      const postings = this.invertedIndex.get(token);
      if (!postings) continue;

      // IDF = ln((N - df + 0.5) / (df + 0.5) + 1)
      const df = postings.size;
      const idf = Math.log((this.totalDocs - df + 0.5) / (df + 0.5) + 1);

      for (const [docId, posting] of postings) {
        const docLen = this.docLengths.get(docId) ?? 0;
        const tf = posting.tf;

        // BM25 term score
        const tfNorm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * docLen / this.avgDocLength));
        const termScore = idf * tfNorm;

        scores.set(docId, (scores.get(docId) ?? 0) + termScore);
      }
    }

    // Sort by score, take top N
    const results = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([docId, score]) => ({
        doc: this.documents.get(docId)!,
        score,
      }))
      .filter((r) => r.doc != null);

    return results;
  }

  /** Rebuild index from all soul/ data sources */
  async rebuild(): Promise<void> {
    const startTime = Date.now();
    this.clear();

    const soulDir = join(process.cwd(), 'soul');

    // 1. Narrative entries — read from SQLite (Phase 2)
    try {
      const { getDb } = await import('../core/database.js');
      const db = getDb();
      const rows = db.prepare(
        `SELECT id, summary, type, timestamp FROM narrative ORDER BY id DESC LIMIT 1000`,
      ).all() as Array<{ id: number; summary: string; type: string; timestamp: string }>;
      for (const row of rows) {
        this.upsert({
          id: `narrative:${row.id}`,
          source: 'narrative',
          text: row.summary,
          tokens: tokenize(row.summary),
          metadata: { type: row.type, timestamp: row.timestamp },
        });
      }
    } catch {
      // Fallback to JSONL if SQLite unavailable
      try {
        const narrativePath = join(soulDir, 'narrative.jsonl');
        const recentEntries = await tailReadJsonl<{ summary: string; type: string; timestamp: string }>(narrativePath, 1000, 524288);
        for (let i = 0; i < recentEntries.length; i++) {
          const entry = recentEntries[i]!;
          this.upsert({
            id: `narrative:${i}`,
            source: 'narrative',
            text: entry.summary,
            tokens: tokenize(entry.summary),
            metadata: { type: entry.type, timestamp: entry.timestamp },
          });
        }
      } catch { /* file not found */ }
    }

    // 2. Chat memory files
    try {
      const { readdir } = await import('node:fs/promises');
      const memDir = join(soulDir, 'memory');
      const files = await readdir(memDir);
      for (const file of files) {
        if (!file.endsWith('_memory.json')) continue;
        try {
          const raw = await readFile(join(memDir, file), 'utf-8');
          const mem = JSON.parse(raw) as {
            chatId: number;
            topics: Array<{ topic: string }>;
            decisions: Array<{ decision: string; context: string }>;
            events: Array<{ event: string }>;
          };
          const cid = mem.chatId;

          for (const [i, t] of mem.topics.entries()) {
            this.upsert({
              id: `topic:${cid}:${i}`,
              source: 'topic',
              text: t.topic,
              tokens: tokenize(t.topic),
              metadata: { chatId: cid },
            });
          }
          for (const [i, d] of mem.decisions.entries()) {
            const text = `${d.decision} ${d.context}`;
            this.upsert({
              id: `decision:${cid}:${i}`,
              source: 'decision',
              text,
              tokens: tokenize(text),
              metadata: { chatId: cid },
            });
          }
          for (const [i, e] of mem.events.entries()) {
            this.upsert({
              id: `event:${cid}:${i}`,
              source: 'event',
              text: e.event,
              tokens: tokenize(e.event),
              metadata: { chatId: cid },
            });
          }
        } catch { /* skip malformed file */ }
      }
    } catch { /* memory dir not found */ }

    // 3. User facts
    try {
      const raw = await readFile(join(soulDir, 'users.json'), 'utf-8');
      const data = JSON.parse(raw) as { users: Record<string, { facts: string[]; id: number }> };
      for (const [uid, user] of Object.entries(data.users)) {
        for (const [i, fact] of user.facts.entries()) {
          this.upsert({
            id: `fact:${uid}:${i}`,
            source: 'fact',
            text: fact,
            tokens: tokenize(fact),
            metadata: { userId: user.id },
          });
        }
      }
    } catch { /* users.json not found */ }

    // 4. Learning patterns
    try {
      const raw = await readFile(join(soulDir, 'learning-patterns.json'), 'utf-8');
      const data = JSON.parse(raw) as {
        patterns: {
          successes: Array<{ details: string }>;
          insights: Array<{ insight: string }>;
        };
      };
      for (const [i, s] of data.patterns.successes.entries()) {
        this.upsert({
          id: `learning:success:${i}`,
          source: 'learning',
          text: s.details,
          tokens: tokenize(s.details),
        });
      }
      for (const [i, ins] of data.patterns.insights.entries()) {
        this.upsert({
          id: `learning:insight:${i}`,
          source: 'learning',
          text: ins.insight,
          tokens: tokenize(ins.insight),
        });
      }
    } catch { /* learning-patterns not found */ }

    // 5. Knowledge-base files (internal .md and .txt documents)
    try {
      const { readdir } = await import('node:fs/promises');
      const kbDir = join(process.cwd(), 'data', 'knowledge', 'internal');
      const files = await readdir(kbDir).catch(() => [] as string[]);
      for (const file of files) {
        if (!file.endsWith('.md') && !file.endsWith('.txt')) continue;
        try {
          const content = await readFile(join(kbDir, file), 'utf-8');
          // Split into paragraphs for finer-grained indexing
          const paragraphs = content.split(/\n{2,}/).filter((p) => p.trim().length > 20);
          for (const [i, para] of paragraphs.entries()) {
            const text = para.trim().slice(0, 500); // cap per-paragraph length
            this.upsert({
              id: `kb:${file}:${i}`,
              source: 'fact',
              text,
              tokens: tokenize(text),
              metadata: { file, type: 'knowledge-base' },
            });
          }
        } catch { /* skip unreadable file */ }
      }
    } catch { /* knowledge dir not found — fine */ }

    // 6. Archived narrative entries (older than 7 days, moved by archiveOldNarrative)
    try {
      const { readdir: rd } = await import('node:fs/promises');
      const archiveDir = join(soulDir, 'narrative-archive');
      const archiveFiles = await rd(archiveDir).catch(() => [] as string[]);
      for (const file of archiveFiles) {
        if (!file.endsWith('.jsonl')) continue;
        try {
          const raw = await readFile(join(archiveDir, file), 'utf-8');
          const archiveLines = raw.split('\n').filter((l) => l.trim());
          for (let i = 0; i < archiveLines.length; i++) {
            try {
              const entry = JSON.parse(archiveLines[i]!) as { summary: string; type: string; timestamp: string };
              this.upsert({
                id: `narrative-archive:${file}:${i}`,
                source: 'narrative',
                text: entry.summary,
                tokens: tokenize(entry.summary),
                metadata: { type: entry.type, timestamp: entry.timestamp, archived: true },
              });
            } catch { /* skip malformed */ }
          }
        } catch { /* skip unreadable file */ }
      }
    } catch { /* archive dir not found — fine */ }

    // 7. Compressed memory entries (generated by memory-compressor)
    try {
      const { readdir: rd2 } = await import('node:fs/promises');
      const memDir = join(soulDir, 'memory');
      const memFiles = await rd2(memDir).catch(() => [] as string[]);
      for (const file of memFiles) {
        if (!file.endsWith('_archive.jsonl')) continue;
        try {
          const raw = await readFile(join(memDir, file), 'utf-8');
          const compLines = raw.split('\n').filter((l) => l.trim());
          for (let i = 0; i < compLines.length; i++) {
            try {
              const entry = JSON.parse(compLines[i]!) as {
                id: string;
                chatId: number;
                summary: string;
                keyTopics: string[];
              };
              this.upsert({
                id: entry.id,
                source: 'compressed',
                text: entry.summary,
                tokens: tokenize(entry.summary),
                metadata: { chatId: entry.chatId, keyTopics: entry.keyTopics },
              });
            } catch { /* skip malformed */ }
          }
        } catch { /* skip unreadable file */ }
      }
    } catch { /* memory dir not found — fine */ }

    this.initialized = true;
    const elapsed = Date.now() - startTime;
    await logger.info(
      'SearchIndex',
      `Index rebuilt: ${this.totalDocs} documents, ${this.invertedIndex.size} unique tokens, ${elapsed}ms`,
    );
  }

  /** Register EventBus listeners for incremental updates */
  setupListeners(): void {
    eventBus.on('narrative:entry', (data) => {
      const id = `narrative:live:${Date.now()}`;
      this.upsert({
        id,
        source: 'narrative',
        text: data.summary,
        tokens: tokenize(data.summary),
        metadata: { type: data.type },
      });

      // Cap live narrative entries at 1000 to prevent unbounded growth
      const livePrefix = 'narrative:live:';
      const liveIds = [...this.documents.keys()].filter(k => k.startsWith(livePrefix));
      if (liveIds.length > 1000) {
        liveIds.sort();
        for (const oldId of liveIds.slice(0, liveIds.length - 1000)) {
          this.remove(oldId);
        }
      }
    });

    eventBus.on('memory:updated', async (data) => {
      try {
        const { getMemory } = await import('./chat-memory.js');
        const mem = await getMemory(data.chatId);
        const cid = data.chatId;

        // Precise single-item upsert when index is provided
        if (data.index != null) {
          if (data.type === 'topic') {
            const t = mem.topics[data.index];
            if (t) this.upsert({ id: `topic:${cid}:${data.index}`, source: 'topic', text: t.topic, tokens: tokenize(t.topic), metadata: { chatId: cid } });
          } else if (data.type === 'decision') {
            const d = mem.decisions[data.index];
            if (d) {
              const text = `${d.decision} ${d.context}`;
              this.upsert({ id: `decision:${cid}:${data.index}`, source: 'decision', text, tokens: tokenize(text), metadata: { chatId: cid } });
            }
          } else if (data.type === 'event') {
            const e = mem.events[data.index];
            if (e) this.upsert({ id: `event:${cid}:${data.index}`, source: 'event', text: e.event, tokens: tokenize(e.event), metadata: { chatId: cid } });
          }
          return;
        }

        // Fallback: full re-index when no index provided (backward compat)
        if (data.type === 'topic') {
          for (const [i, t] of mem.topics.entries()) {
            this.upsert({
              id: `topic:${cid}:${i}`,
              source: 'topic',
              text: t.topic,
              tokens: tokenize(t.topic),
              metadata: { chatId: cid },
            });
          }
        } else if (data.type === 'decision') {
          for (const [i, d] of mem.decisions.entries()) {
            const text = `${d.decision} ${d.context}`;
            this.upsert({
              id: `decision:${cid}:${i}`,
              source: 'decision',
              text,
              tokens: tokenize(text),
              metadata: { chatId: cid },
            });
          }
        } else if (data.type === 'event') {
          for (const [i, e] of mem.events.entries()) {
            this.upsert({
              id: `event:${cid}:${i}`,
              source: 'event',
              text: e.event,
              tokens: tokenize(e.event),
              metadata: { chatId: cid },
            });
          }
        }
      } catch {
        // Non-fatal: incremental update failed
      }
    });

    eventBus.on('memory:compressed', async (data) => {
      // Index newly compressed memory entries
      try {
        const memDir = join(process.cwd(), 'soul', 'memory');
        const archiveFile = join(memDir, `${data.chatId}_archive.jsonl`);
        const raw = await readFile(archiveFile, 'utf-8');
        const compLines = raw.split('\n').filter((l) => l.trim());
        for (let i = 0; i < compLines.length; i++) {
          try {
            const entry = JSON.parse(compLines[i]!) as {
              id: string;
              chatId: number;
              summary: string;
              keyTopics: string[];
            };
            this.upsert({
              id: entry.id,
              source: 'compressed',
              text: entry.summary,
              tokens: tokenize(entry.summary),
              metadata: { chatId: entry.chatId, keyTopics: entry.keyTopics },
            });
          } catch { /* skip malformed */ }
        }
      } catch { /* archive file not found */ }
    });

    eventBus.on('identity:changed', (data) => {
      if (typeof data.newValue === 'string') {
        this.upsert({
          id: `identity:${data.field}`,
          source: 'fact',
          text: data.newValue,
          tokens: tokenize(data.newValue),
          metadata: { field: data.field },
        });
      }
    });
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  get documentCount(): number {
    return this.totalDocs;
  }

  // --- Internal helpers ---

  private removeFromInverted(docId: string): void {
    const doc = this.documents.get(docId);
    if (!doc) return;

    const tokenSet = new Set(doc.tokens);
    for (const token of tokenSet) {
      const postings = this.invertedIndex.get(token);
      if (postings) {
        postings.delete(docId);
        if (postings.size === 0) {
          this.invertedIndex.delete(token);
        }
      }
    }
  }

  private clear(): void {
    this.documents.clear();
    this.invertedIndex.clear();
    this.docLengths.clear();
    this.avgDocLength = 0;
    this.totalDocs = 0;
    this.totalDocLength = 0;
    this.initialized = false;
  }
}

// Singleton instance
export const searchIndex = new MemorySearchIndex();

/** Initialize the search index: rebuild + setup event listeners */
export async function initSearchIndex(): Promise<void> {
  await searchIndex.rebuild();
  searchIndex.setupListeners();
}
