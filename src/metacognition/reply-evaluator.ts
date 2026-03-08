/**
 * Reply quality self-evaluation.
 *
 * After each reply, evaluate quality using simple deterministic rules
 * (no AI needed) and record the score to learning-patterns.
 *
 * Scoring dimensions (each 0-1, summed to 0-5):
 *   1. Length adequacy   — too short or too long penalized
 *   2. Responsiveness    — does it address the user's question/request?
 *   3. Emotional warmth  — contains empathetic or warm language?
 *   4. Actionability     — contains concrete info, code, or steps?
 *   5. Clarity           — well-structured (has line breaks, not a wall of text)?
 */

import { logger } from '../core/logger.js';

// ── Scoring Constants ────────────────────────────────────────────────

const LENGTH = {
  SHORT_QUESTION: 20, MEDIUM_QUESTION: 100,
  SHORT_REPLY_MIN: 5, SHORT_REPLY_MAX: 2000, SHORT_VERBOSE_PENALTY: 0.6,
  MEDIUM_REPLY_MIN: 20, MEDIUM_REPLY_MAX: 3000, MIN_ACK_LENGTH: 10,
  MEDIUM_BRIEF_SCORE: 0.6, MEDIUM_MINIMAL_SCORE: 0.4, MEDIUM_TINY_SCORE: 0.3,
  LONG_REPLY_MIN: 50, LONG_BRIEF_SCORE: 0.7,
  LONG_MINIMAL_SCORE: 0.5, LONG_TINY_SCORE: 0.3,
} as const;

const RESPONSIVENESS = {
  MATCH_HIGH_RATIO: 0.2,  MATCH_LOW_RATIO: 0.05,
  MATCH_HIGH_SCORE: 1,     MATCH_MID_SCORE: 0.7,     MATCH_LOW_SCORE: 0.5,
  NO_KEYWORD_SCORE: 0.8,   ENGAGE_MIN_LENGTH: 30,     ENGAGE_BONUS: 0.15,
  PROPORTIONAL_RATIO: 1.2,    PROPORTIONAL_MIN_LENGTH: 20,        PROPORTIONAL_BONUS: 0.15,
} as const;

const EMOTION = {
  SUBSTANTIAL_LENGTH: 50,    SUBSTANTIAL_BASE_SCORE: 0.5,
  SHORT_BASE_SCORE: 0.4,     STRONG_BONUS: 0.2,
  MILD_BONUS: 0.1,
} as const;

const ACTION = {
  CODE: 0.35,   STEPS: 0.25,    PATH: 0.15,
  URL: 0.15,    CONCRETE: 0.15, QUESTION_ANSWER: 0.3,
  NON_QUESTION: 0.5,   MIN_LENGTH: 10,   FALLBACK_LENGTH: 30,
  FALLBACK: 0.3,
} as const;

const CLARITY = {
  SHORT_THRESHOLD: 100,  SHORT_GOOD_SCORE: 0.8,   SHORT_MIN_SCORE: 0.5,
  BASE: 0.3,             PARAGRAPH_BONUS: 0.2,    MARKDOWN_BONUS: 0.2,
  LONG_PARAGRAPH: 500,   LONG_BONUS: 0.15,        LEN_BONUS: 0.15,
  MIN_LENGTH: 20,        MIN_SHORT_LENGTH: 5,
} as const;

const GRADE = { EXCELLENT: 4, GOOD: 3, FAIR: 2 } as const;

export interface ReplyScore {
  total: number;           // 0-5
  lengthScore: number;     // 0-1
  responsivenessScore: number;
  emotionScore: number;
  actionScore: number;
  clarityScore: number;
  grade: 'excellent' | 'good' | 'fair' | 'poor';
}

/**
 * Evaluate a reply's quality given the user's original message.
 */
export function evaluateReply(userMessage: string, reply: string): ReplyScore {
  const lengthScore = scoreLengthAdequacy(userMessage, reply);
  const responsivenessScore = scoreResponsiveness(userMessage, reply);
  const emotionScore = scoreEmotion(reply);
  const actionScore = scoreActionability(userMessage, reply);
  const clarityScore = scoreClarity(reply);

  // Round to 1 decimal to avoid display/logic mismatch (e.g. 2.95 displays as "3.0" but fails >= 3)
  const total = Math.round((lengthScore + responsivenessScore + emotionScore + actionScore + clarityScore) * 10) / 10;

  let grade: ReplyScore['grade'];
  if (total >= GRADE.EXCELLENT) grade = 'excellent';
  else if (total >= GRADE.GOOD) grade = 'good';
  else if (total >= GRADE.FAIR) grade = 'fair';
  else grade = 'poor';

  return { total, lengthScore, responsivenessScore, emotionScore, actionScore, clarityScore, grade };
}

/**
 * 1. Length adequacy — reply should be proportional to the question.
 *    Short questions can have short answers. Long/complex questions need longer replies.
 */
function scoreLengthAdequacy(userMsg: string, reply: string): number {
  const userLen = userMsg.length;
  const replyLen = reply.length;

  // Empty reply is bad
  if (replyLen === 0) return 0;

  // For short questions, any reasonable reply is fine
  if (userLen < LENGTH.SHORT_QUESTION) {
    if (replyLen >= LENGTH.SHORT_REPLY_MIN && replyLen <= LENGTH.SHORT_REPLY_MAX) return 1;
    if (replyLen > LENGTH.SHORT_REPLY_MAX) return LENGTH.SHORT_VERBOSE_PENALTY;
    return 0.5;
  }

  // For medium questions, expect at least some substance
  if (userLen < LENGTH.MEDIUM_QUESTION) {
    if (replyLen >= LENGTH.MEDIUM_REPLY_MIN && replyLen <= LENGTH.MEDIUM_REPLY_MAX) return 1;
    if (replyLen >= LENGTH.MIN_ACK_LENGTH) return LENGTH.MEDIUM_BRIEF_SCORE;
    if (replyLen >= LENGTH.SHORT_REPLY_MIN) return LENGTH.MEDIUM_MINIMAL_SCORE;
    return LENGTH.MEDIUM_TINY_SCORE;
  }

  // For long/complex questions, expect a detailed reply
  if (replyLen >= LENGTH.LONG_REPLY_MIN) return 1;
  if (replyLen >= LENGTH.MEDIUM_REPLY_MIN) return LENGTH.LONG_BRIEF_SCORE;
  if (replyLen >= LENGTH.SHORT_REPLY_MIN) return LENGTH.LONG_MINIMAL_SCORE;
  return LENGTH.LONG_TINY_SCORE;
}

/**
 * 2. Responsiveness — does the reply address what was asked?
 *    Uses character n-gram matching for CJK and word matching for Latin.
 *    Also considers reply length relative to the question as a proxy for engagement.
 */
function scoreResponsiveness(userMsg: string, reply: string): number {
  const replyLower = reply.toLowerCase();
  const userLower = userMsg.toLowerCase();

  const stopWords = new Set([
    '的', '了', '嗎', '呢', '是', '在', '有', '我', '你', '他', '她', '它',
    '這', '那', '個', '一', '不', '也', '都', '就', '會', '能', '可以', '什麼',
    '嗯', '喔', '哦', '啊', '吧', '好', '對',  // filler/acknowledgment words
    'the', 'a', 'is', 'are', 'to', 'and', 'or', 'it', 'in', 'on', 'for',
    'do', 'can', 'how', 'what', 'why', 'when', 'where', 'this', 'that',
  ]);

  // Split Latin words by whitespace/punctuation
  const latinWords = userLower
    .split(/[\s,.\-!?，。！？、：；\n]+/)
    .filter((w) => /^[a-z0-9]/.test(w) && w.length >= 2 && !stopWords.has(w));

  // Extract CJK bigrams from the ORIGINAL character sequence (before stop-word filtering)
  // to preserve natural word boundaries. Filter stop-words only for single-char tokens.
  const cjkChars = [...userLower.replace(/[^\u4e00-\u9fff]/g, '')];
  const cjkBigrams: string[] = [];
  for (let i = 0; i < cjkChars.length - 1; i++) {
    const bigram = cjkChars[i]! + cjkChars[i + 1]!;
    // Skip bigrams composed entirely of stop words
    if (!stopWords.has(cjkChars[i]!) || !stopWords.has(cjkChars[i + 1]!)) {
      cjkBigrams.push(bigram);
    }
  }
  // Also include individual CJK chars that are not stop words
  const cjkSingles = cjkChars.filter((ch) => !stopWords.has(ch));

  const tokens = [...latinWords, ...cjkBigrams];
  // Fallback: if no bigrams, use single CJK characters
  if (cjkBigrams.length === 0 && cjkSingles.length > 0) {
    tokens.push(...cjkSingles);
  }

  if (tokens.length === 0) return RESPONSIVENESS.NO_KEYWORD_SCORE;

  const matched = tokens.filter((t) => replyLower.includes(t)).length;
  const ratio = matched / tokens.length;

  // Token match scoring — lowered thresholds to be more forgiving of CJK
  // paraphrasing where synonyms naturally replace original terms.
  let tokenScore: number;
  if (ratio >= RESPONSIVENESS.MATCH_HIGH_RATIO) tokenScore = RESPONSIVENESS.MATCH_HIGH_SCORE;
  else if (ratio >= RESPONSIVENESS.MATCH_LOW_RATIO) tokenScore = RESPONSIVENESS.MATCH_MID_SCORE;
  else tokenScore = RESPONSIVENESS.MATCH_LOW_SCORE;

  // Engagement bonus: a substantive reply to a question shows effort even if
  // wording differs (common in CJK where synonyms/paraphrasing is natural).
  let engagementBonus = 0;
  if (reply.length >= RESPONSIVENESS.ENGAGE_MIN_LENGTH && userMsg.length > 0) {
    engagementBonus = RESPONSIVENESS.ENGAGE_BONUS;
  }

  // Length-proportional bonus: longer replies relative to question indicate
  // genuine engagement even when lexical overlap is low (CJK paraphrasing).
  if (userMsg.length > 0 && reply.length >= userMsg.length * RESPONSIVENESS.PROPORTIONAL_RATIO && reply.length >= RESPONSIVENESS.PROPORTIONAL_MIN_LENGTH) {
    engagementBonus += RESPONSIVENESS.PROPORTIONAL_BONUS;
  }

  return Math.min(1, tokenScore + engagementBonus);
}

/**
 * 3. Emotional warmth — does the reply show empathy or personality?
 *    Starts with a baseline so purely technical replies aren't penalized to zero.
 *    Uses tiered indicators: strong warmth (+0.2) and mild warmth (+0.1).
 */
function scoreEmotion(reply: string): number {
  // Baseline: any non-trivial reply gets warmth credit.
  // Personality exists in tone, not just words — a helpful, substantive
  // technical answer carries implicit warmth through the act of helping.
  let score: number;
  if (reply.length >= EMOTION.SUBSTANTIAL_LENGTH) score = EMOTION.SUBSTANTIAL_BASE_SCORE;
  else if (reply.length >= LENGTH.SHORT_REPLY_MIN) score = EMOTION.SHORT_BASE_SCORE;
  else score = 0;

  // Strong warmth indicators (+0.2 each)
  const strongWarmth = [
    // Emojis
    /[😊😄😀🎉👍❤️💪🙏😃🥰💡⭐🌟✨🎊🔧🚀📝💻🎯🤔💭🫡👋🎵😉😎🤗]/,
    // Caring expressions
    /記得休息|別太累|注意身體|早點睡|好好吃飯|保重|辛苦了|謝謝|感謝/,
    // Chinese warm words
    /加油|恭喜|棒|開心|高興|喜歡|厲害|太好了|真的很|不錯喔|做得好/,
  ];

  // Mild warmth indicators (+0.1 each)
  const mildWarmth = [
    // Acknowledgment and affirmation
    /好的|沒問題|當然|了解|明白|收到|放心|可以|嗯嗯|對對/,
    // Inclusive / service language
    /我們|一起|幫你|為你|陪你|給你|替你|這裡|這邊|可以試試/,
    // Exclamation marks (enthusiasm)
    /！|!/,
    // Polite/conversational markers (sentence-final particles show personality)
    /呢|喔|哦|啊|吧|唷|嘛|囉|～|~|☺/,
    // Softeners and hedges (show thoughtfulness)
    /也許|可能|或許|不過|其實|應該|看看|試試|參考/,
    // Completion / success words (positive framing)
    /完成|成功|順利|搞定|解決|沒錯|很好|不錯/,
    // Technical helpfulness (diagnosing, investigating — shows care)
    /問題|原因|建議|檢查|修正|確認|調整|處理|分析|排查/,
  ];

  for (const pattern of strongWarmth) {
    if (pattern.test(reply)) {
      score += EMOTION.STRONG_BONUS;
    }
  }
  for (const pattern of mildWarmth) {
    if (pattern.test(reply)) {
      score += EMOTION.MILD_BONUS;
    }
  }

  return Math.min(1, score);
}

/**
 * 4. Actionability — does the reply contain concrete, useful content?
 */
function scoreActionability(userMsg: string, reply: string): number {
  let score = 0;

  // Contains code blocks
  if (/```/.test(reply) || /`[^`]+`/.test(reply)) score += ACTION.CODE;

  // Contains step-by-step structure (numbers or bullets)
  if (/\d+[.、）]|\n[-•*]\s/.test(reply)) score += ACTION.STEPS;

  // Contains file paths
  if (/\/[\w.\-/]+\.\w+/.test(reply)) score += ACTION.PATH;

  // Contains URLs
  if (/https?:\/\//.test(reply)) score += ACTION.URL;

  // Contains concrete information (Chinese info markers)
  if (/已經|完成|設定|修改|新增|刪除|更新|執行|啟動|安裝/.test(reply)) score += ACTION.CONCRETE;

  // If the user asked a question, check if reply has a declarative answer
  const isQuestion = /[?？]|嗎|呢|什麼|如何|為什麼|怎麼|可以|能不能|有沒有/.test(userMsg);
  if (isQuestion && reply.length > ACTION.MIN_LENGTH) score += ACTION.QUESTION_ANSWER;

  // If the user didn't ask a question, engagement is the measure of actionability
  if (!isQuestion && reply.length >= ACTION.MIN_LENGTH) score += ACTION.NON_QUESTION;

  // Baseline: any substantive reply has some actionability
  if (score === 0 && reply.length >= ACTION.FALLBACK_LENGTH) score = ACTION.FALLBACK;

  return Math.min(1, score);
}

/**
 * 5. Clarity — is the reply well-structured?
 *    Short replies (< 100 chars) are scored more leniently since brevity is clarity.
 */
function scoreClarity(reply: string): number {
  // Short replies: brevity IS clarity — give generous base
  if (reply.length > 0 && reply.length < CLARITY.SHORT_THRESHOLD) {
    return reply.length >= CLARITY.MIN_SHORT_LENGTH ? CLARITY.SHORT_GOOD_SCORE : CLARITY.SHORT_MIN_SCORE;
  }

  let score = CLARITY.BASE;

  // Has paragraph breaks
  if (reply.includes('\n\n') || reply.includes('\n')) score += CLARITY.PARAGRAPH_BONUS;

  // Has Markdown formatting
  if (/\*[^*]+\*/.test(reply) || /#{1,3}\s/.test(reply)) score += CLARITY.MARKDOWN_BONUS;

  // Not a single massive paragraph
  const longestParagraph = reply.split(/\n/).reduce(
    (max, line) => Math.max(max, line.length), 0,
  );
  if (longestParagraph < CLARITY.LONG_PARAGRAPH) score += CLARITY.LONG_BONUS;

  // Reasonable length (not just a single word)
  if (reply.length >= CLARITY.MIN_LENGTH) score += CLARITY.LEN_BONUS;

  return Math.min(1, score);
}

/**
 * Evaluate and record to learning patterns.
 * Call this after sending a reply.
 */
export async function evaluateAndRecord(
  userMessage: string,
  reply: string,
): Promise<ReplyScore> {
  const score = evaluateReply(userMessage, reply);

  try {
    const { recordSuccess, recordFailure, addInsight } = await import('./learning-tracker.js');

    const summary = `品質=${score.total.toFixed(1)}/5 (${score.grade}) | 長度=${score.lengthScore.toFixed(1)} 切題=${score.responsivenessScore.toFixed(1)} 情感=${score.emotionScore.toFixed(1)} 實用=${score.actionScore.toFixed(1)} 清晰=${score.clarityScore.toFixed(1)}`;

    if (score.total >= GRADE.GOOD) {
      await recordSuccess('reply-quality', summary);
    } else {
      await recordFailure('reply-quality', summary);
    }

    // Generate insight on patterns
    const { getPatternsByCategory } = await import('./learning-tracker.js');
    const stats = await getPatternsByCategory('reply-quality');
    const total = stats.successes.length + stats.failures.length;

    if (total > 0 && total % 20 === 0) {
      const rate = (stats.successRate * 100).toFixed(0);
      await addInsight(`回覆品質統計（${total} 次）：${rate}% 達到良好以上。`);
    }

    await logger.debug('ReplyEvaluator', `Score: ${score.total.toFixed(1)}/5 (${score.grade})`);
  } catch (err) {
    await logger.warn('ReplyEvaluator', 'Failed to record evaluation', err);
  }

  return score;
}
