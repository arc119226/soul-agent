/**
 * Smart model router — fast-path regex classification.
 * Routes messages to the most appropriate model tier.
 */

import { config } from '../config.js';

export type ModelTier = 'haiku' | 'sonnet' | 'opus';

/** Per-tier timeout for user-facing Claude Code calls (ms) */
export const MODEL_TIMEOUTS: Record<ModelTier, number> = {
  haiku: 120_000,     // 2 min
  sonnet: 300_000,    // 5 min
  opus: 1_800_000,    // 30 min — main consciousness should not timeout easily
};

export interface RouteDecision {
  tier: ModelTier;
  /** Actual model ID (e.g. "claude-haiku-4-5-20251001") */
  model: string;
  /** Classification reason (for logging) */
  reason: string;
  /** Skip session --resume */
  skipResume: boolean;
  /** Use lightweight system prompt */
  lightContext: boolean;
  /** Text with intent marker stripped (if any). Caller should use this for the prompt. */
  strippedText?: string;
}

// ── Model ID lookup ──

function modelIdFor(tier: ModelTier): string {
  switch (tier) {
    case 'haiku':  return config.MODEL_TIER_HAIKU;
    case 'sonnet': return config.MODEL_TIER_SONNET;
    case 'opus':   return config.MODEL_TIER_OPUS || ''; // empty = CLI default
  }
}

function buildDecision(tier: ModelTier, reason: string): RouteDecision {
  return {
    tier,
    model: modelIdFor(tier),
    reason,
    skipResume: tier === 'haiku',
    lightContext: tier === 'haiku',
  };
}

// ── Fast-path: regex classification (no API call) ──

const GREETING_RE = /^(哈囉|你好|嗨|hi|hello|hey|早安|午安|晚安|掰掰|88|bye|good\s*(morning|night|evening))[\s!！。~～]*$/i;
const CONFIRM_RE = /^(好|好的|OK|ok|收到|了解|謝謝|辛苦了?|嗯|對|是|沒問題|讚|棒|不錯|感謝)[\s!！。~～]*$/i;
const CODE_BLOCK_RE = /```/;
const URL_RE = /https?:\/\//;

/** Technical keywords that strongly indicate opus-tier (code/system/research) */
const TECH_EN_RE = /(?:function|class|import|export|async|await|const|let|var|return|error|bug|fix|refactor|deploy|build|test|api|sql|css|html|npm|git|docker|typescript|python|rust|golang|node\.?js|react|vue|angular|webpack|vite|ci\/cd|pipeline|database|query|server|endpoint|migration|schema|debug|log|stack\s*trace|exception|compile|tsconfig|eslint|prettier)/i;

/** Opus-tier Chinese keywords — technical terms commonly used in code/system discussions */
const TECH_CN_RE = /(?:程式|代碼|程式碼|函式|函數|變數|物件|陣列|伺服器|資料庫|部署|編譯|除錯|重構|架構|演算法|效能|優化|安全性|漏洞|記憶體|介面|協定|模組|套件|框架|終端|指令|腳本|模型|推理|向量|嵌入|微調|訓練|分類|提示詞|token)/;

/** Casual/emotional patterns → haiku */
const EMOJI_ONLY_RE = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s!！？?~～。.，,]+$/u;
const EMOTION_RE = /^(哈哈|嘻嘻|呵呵|嗚嗚|QQ|TAT|orz|XD|LOL|LMAO|OMG|呃|唉|噢|嘿|嘿嘿|哼|痾|蛤|啊|噗|嗯嗯|哦|喔|欸)[\s!！~～。.]*$/i;

/** Explicit command prefix → opus (tool operations) */
const COMMAND_PREFIX_RE = /^\//;

/** Intent marker: ~ or ～ prefix → opus (deep thinking / explicit action) */
const INTENT_DEEP_RE = /^[~～]/;

/** Intent marker: ? or ？ prefix → sonnet (smart daily tasks without full opus) */
const INTENT_SONNET_RE = /^[?？]/;

function tryFastClassify(text: string): { tier: ModelTier; reason: string } | null {
  const trimmed = text.trim();

  // ── Explicit intent signals (highest priority — user's deliberate choice) ──

  // Slash commands → opus (tool operations)
  if (COMMAND_PREFIX_RE.test(trimmed)) {
    return { tier: 'opus', reason: 'fast-path: command' };
  }

  // Intent marker: ~ prefix → opus (deep thinking / explicit action)
  if (INTENT_DEEP_RE.test(trimmed)) {
    return { tier: 'opus', reason: 'fast-path: intent-marker ~' };
  }

  // Intent marker: ? prefix → sonnet (smart daily tasks)
  if (INTENT_SONNET_RE.test(trimmed)) {
    return { tier: 'sonnet', reason: 'fast-path: intent-marker ?' };
  }

  // ── Heuristic classification (inferred from message content) ──

  // Ultra-short messages without technical content → haiku
  if (trimmed.length <= 4 && !/[a-z]{2,}/i.test(trimmed)) {
    return { tier: 'haiku', reason: 'fast-path: ultra-short' };
  }

  if (GREETING_RE.test(trimmed)) {
    return { tier: 'haiku', reason: 'fast-path: greeting' };
  }

  if (CONFIRM_RE.test(trimmed)) {
    return { tier: 'haiku', reason: 'fast-path: confirmation' };
  }

  // Emoji-only or emotional expression → haiku
  if (EMOJI_ONLY_RE.test(trimmed)) {
    return { tier: 'haiku', reason: 'fast-path: emoji-only' };
  }

  if (EMOTION_RE.test(trimmed)) {
    return { tier: 'haiku', reason: 'fast-path: emotion' };
  }

  if (CODE_BLOCK_RE.test(trimmed)) {
    return { tier: 'opus', reason: 'fast-path: code-block' };
  }

  if (URL_RE.test(trimmed)) {
    return { tier: 'opus', reason: 'fast-path: url' };
  }

  // Technical keywords → opus
  if (TECH_EN_RE.test(trimmed) || TECH_CN_RE.test(trimmed)) {
    return { tier: 'opus', reason: 'fast-path: technical-keywords' };
  }

  // Short casual messages (≤15 chars, no technical terms) → haiku
  if (trimmed.length <= 15) {
    return { tier: 'haiku', reason: 'fast-path: short-casual' };
  }

  // Long messages (>200 chars) without code blocks are likely complex discussions → sonnet
  if (trimmed.length > 200) {
    return { tier: 'sonnet', reason: 'fast-path: long-message' };
  }

  return null;
}

// ── Main entry point ──

export function routeMessage(text: string, _userId: number): RouteDecision {
  // Step 1: Try fast-path regex
  const fast = tryFastClassify(text);
  if (fast) {
    const decision = buildDecision(fast.tier, fast.reason);
    // Strip intent marker prefix so Claude receives clean text
    if (fast.reason.includes('intent-marker')) {
      decision.strippedText = text.replace(/^[~～?？]\s*/, '');
    }
    return decision;
  }

  // Step 2: Default to sonnet for ambiguous messages (Haiku classifier removed for performance)
  return buildDecision('sonnet', 'default-fallback: sonnet');
}
