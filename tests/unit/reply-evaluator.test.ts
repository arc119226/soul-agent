import { describe, it, expect } from 'vitest';

// reply-evaluator.ts exports a pure function evaluateReply — no mocks needed
import { evaluateReply } from '../../src/metacognition/reply-evaluator.js';

describe('evaluateReply', () => {
  // ---------------------------------------------------------------------------
  // Overall structure
  // ---------------------------------------------------------------------------

  it('returns a score object with all dimensions', () => {
    const score = evaluateReply('你好', '你好！很高興認識你！');
    expect(score).toHaveProperty('total');
    expect(score).toHaveProperty('lengthScore');
    expect(score).toHaveProperty('responsivenessScore');
    expect(score).toHaveProperty('emotionScore');
    expect(score).toHaveProperty('actionScore');
    expect(score).toHaveProperty('clarityScore');
    expect(score).toHaveProperty('grade');
    expect(score.total).toBeGreaterThanOrEqual(0);
    expect(score.total).toBeLessThanOrEqual(5);
  });

  // ---------------------------------------------------------------------------
  // Grade thresholds
  // ---------------------------------------------------------------------------

  it('grades >= 4 as excellent', () => {
    // Craft a reply that should score high on all dimensions
    const reply = [
      '好的！讓我幫你整理一下：',
      '',
      '1. 首先檢查設定檔',
      '2. 確認 `config.ts` 中的參數',
      '3. 執行 `/path/to/script.js`',
      '',
      '加油！有問題隨時問我 😊',
    ].join('\n');

    const score = evaluateReply('如何設定 TypeScript 專案？', reply);
    expect(score.grade).toBe('excellent');
  });

  it('grades empty reply as poor', () => {
    const score = evaluateReply('你好', '');
    expect(score.grade).toBe('poor');
    expect(score.lengthScore).toBe(0);
    // Some dimensions (clarity, responsiveness) have base scores even for empty replies
    expect(score.total).toBeLessThan(2);
  });

  // ---------------------------------------------------------------------------
  // Dimension 1: Length adequacy
  // ---------------------------------------------------------------------------

  it('gives full length score for short question with reasonable reply', () => {
    const score = evaluateReply('你好', '你好！今天怎麼樣？');
    expect(score.lengthScore).toBe(1);
  });

  it('penalizes very short reply to long question', () => {
    const longQuestion = '我想了解 TypeScript 的泛型系統是如何運作的，特別是在處理複雜的條件型別和映射型別時有哪些最佳實踐？';
    const score = evaluateReply(longQuestion, '好');
    expect(score.lengthScore).toBeLessThan(0.5);
  });

  it('handles empty reply', () => {
    const score = evaluateReply('你好', '');
    expect(score.lengthScore).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Dimension 2: Responsiveness
  // ---------------------------------------------------------------------------

  it('scores high when reply echoes keywords from question', () => {
    const score = evaluateReply(
      '如何使用 TypeScript 泛型？',
      '在 TypeScript 中，泛型（Generics）允許你建立可重用的元件。基本語法是 function identity<T>(arg: T): T。',
    );
    expect(score.responsivenessScore).toBeGreaterThanOrEqual(0.7);
  });

  it('scores lower when reply ignores the question topic', () => {
    const score = evaluateReply(
      '如何使用 TypeScript 泛型？',
      '今天天氣真好，要不要出去走走？',
    );
    expect(score.responsivenessScore).toBeLessThan(1);
  });

  it('gives neutral score for very short questions with no keywords', () => {
    const score = evaluateReply('嗯', '好的！');
    expect(score.responsivenessScore).toBe(0.8); // neutral for no-keyword questions
  });

  // ---------------------------------------------------------------------------
  // Dimension 3: Emotional warmth
  // ---------------------------------------------------------------------------

  it('detects emoji warmth', () => {
    const score = evaluateReply('你好', '你好啊 😊');
    expect(score.emotionScore).toBeGreaterThan(0);
  });

  it('detects Chinese warm words', () => {
    const score = evaluateReply('你好', '恭喜你完成了！真的很棒！加油！');
    expect(score.emotionScore).toBeGreaterThan(0);
  });

  it('detects caring expressions', () => {
    const score = evaluateReply('好累', '辛苦了，記得休息哦。早點睡，保重身體！');
    expect(score.emotionScore).toBeGreaterThanOrEqual(0.5);
  });

  it('scores 0 warmth for cold factual reply', () => {
    const score = evaluateReply('1+1=?', '2');
    expect(score.emotionScore).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Dimension 4: Actionability
  // ---------------------------------------------------------------------------

  it('detects code blocks', () => {
    const score = evaluateReply(
      '怎麼寫 hello world',
      '你可以這樣寫：\n```ts\nconsole.log("hello")\n```',
    );
    expect(score.actionScore).toBeGreaterThanOrEqual(0.4);
  });

  it('detects step-by-step structure', () => {
    const score = evaluateReply(
      '如何安裝 Node.js？',
      '1. 前往官網下載\n2. 執行安裝程式\n3. 驗證安裝',
    );
    expect(score.actionScore).toBeGreaterThanOrEqual(0.3);
  });

  it('detects file paths', () => {
    const score = evaluateReply(
      '設定檔在哪？',
      '設定檔位於 /etc/config/app.json',
    );
    expect(score.actionScore).toBeGreaterThan(0);
  });

  it('gives credit for answering questions', () => {
    const score = evaluateReply(
      'TypeScript 是什麼？',
      'TypeScript 是 JavaScript 的超集，加入了靜態型別系統。',
    );
    expect(score.actionScore).toBeGreaterThanOrEqual(0.3);
  });

  // ---------------------------------------------------------------------------
  // Dimension 5: Clarity
  // ---------------------------------------------------------------------------

  it('gives higher clarity for well-structured reply', () => {
    const structured = '## 說明\n\n這是第一段。\n\n這是第二段。\n\n*重點標記*';
    const wall = 'a'.repeat(600);

    const scoreStructured = evaluateReply('說明一下', structured);
    const scoreWall = evaluateReply('說明一下', wall);

    expect(scoreStructured.clarityScore).toBeGreaterThan(scoreWall.clarityScore);
  });

  it('gives base clarity for non-empty reply', () => {
    const score = evaluateReply('嗨', '嗨');
    expect(score.clarityScore).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Regression tests for reply-quality failures (evolution goal 536980d1)
  // ---------------------------------------------------------------------------

  it('gives engagement bonus for long paraphrased reply (CJK synonym scenario)', () => {
    // Simulates a reply that uses completely different words but is long & substantive
    const score = evaluateReply(
      '如何設定資料庫連線？',
      '首先需要在環境變數中配置好主機位址與埠號，然後透過連線池管理器來建立持久化的通道。建議使用連線池以提升效能。',
    );
    expect(score.responsivenessScore).toBeGreaterThanOrEqual(0.65);
  });

  it('gives higher emotion baseline for substantial replies', () => {
    // A 50+ char reply with no explicit warm words should get 0.5 baseline
    const reply = '這個問題的根本原因是設定檔中的路徑有誤，需要修正為正確的絕對路徑才能解決。';
    const score = evaluateReply('為什麼會報錯？', reply);
    expect(score.emotionScore).toBeGreaterThanOrEqual(0.5);
  });

  it('does not fail for brief acknowledgment to medium question', () => {
    // A 10-19 char reply to a medium question should get 0.6 length, not 0.3
    const score = evaluateReply(
      '又有錯誤 {"type":"result"}',
      '我來看看這個問題',
    );
    expect(score.lengthScore).toBeGreaterThanOrEqual(0.4);
  });

  it('passes threshold for typical conversational reply (previous failure pattern)', () => {
    // Simulates the pattern that caused repeated failures:
    // medium question, paraphrased reply, no warm words
    const score = evaluateReply(
      '這次又是什麼問題？',
      '看起來是連線逾時導致的錯誤，因為伺服器在限定時間內沒有回應。我建議增加逾時設定值或檢查網路狀態。',
    );
    expect(score.total).toBeGreaterThanOrEqual(3);
    expect(score.grade).not.toBe('fair');
    expect(score.grade).not.toBe('poor');
  });

  // ---------------------------------------------------------------------------
  // Additional regression tests for historical failures (evolution goal 536980d1)
  // Covers all 6 documented failure patterns from learning-patterns.json
  // ---------------------------------------------------------------------------

  it('passes for short diagnostic reply to long JSON error message', () => {
    // Failure pattern: long user message with JSON, short bot reply
    // Previously scored 2.8 (length=0.3, responsiveness=0.5, emotion=0.5)
    const score = evaluateReply(
      '又有錯誤 {"type":"result","subtype":"error","cost":{"input":0,"output":0},"duration":1234}',
      '我來看看這個問題，應該是連線設定有誤。讓我檢查一下。',
    );
    expect(score.total).toBeGreaterThanOrEqual(3);
  });

  it('passes for technical reply without emotional words', () => {
    // Failure pattern: emotion=0.0 because reply was purely technical
    // Now technical helpfulness words should contribute to emotion score
    const score = evaluateReply(
      '為什麼程式會崩潰？',
      '根據錯誤日誌分析，問題原因是記憶體不足。建議調整設定檔中的記憶體限制參數。',
    );
    expect(score.emotionScore).toBeGreaterThanOrEqual(0.5);
    expect(score.total).toBeGreaterThanOrEqual(3);
  });

  it('gives adequate score for brief but relevant acknowledgment', () => {
    // Failure pattern: very short reply getting penalized across multiple dimensions
    const score = evaluateReply(
      '幫我看看這個',
      '好的，我來處理',
    );
    expect(score.total).toBeGreaterThanOrEqual(2.5);
  });

  it('does not penalize paraphrased CJK replies with zero keyword overlap', () => {
    // Extreme case: reply uses completely different vocabulary
    const score = evaluateReply(
      '如何部署到伺服器？',
      '可以透過容器化的方式將應用程式打包成映像檔，接著上傳到雲端平台執行。',
    );
    expect(score.responsivenessScore).toBeGreaterThanOrEqual(0.5);
  });
});
