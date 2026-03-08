import { describe, it, expect } from 'vitest';
import {
  scoreEmotionalResonance,
  scoreIdentityRelevance,
  scorePracticalValue,
  scoreUniqueness,
  computeQualityScore,
  qualityAdjustedScore,
} from '../../src/memory/memory-quality.js';

describe('Memory Quality — Emotional Resonance', () => {
  it('scores 0 for neutral content', () => {
    const score = scoreEmotionalResonance('今天天氣不錯');
    expect(score).toBe(0);
  });

  it('detects positive Chinese emotional words', () => {
    const score = scoreEmotionalResonance('謝謝你，我好開心！');
    expect(score).toBeGreaterThan(0.2);
  });

  it('detects negative emotional words', () => {
    const score = scoreEmotionalResonance('我很難過也很擔心');
    expect(score).toBeGreaterThan(0.15);
  });

  it('detects English emotional words', () => {
    const score = scoreEmotionalResonance('Thank you, this is amazing!');
    expect(score).toBeGreaterThan(0.2);
  });

  it('boosts for exclamation marks', () => {
    const base = scoreEmotionalResonance('開心');
    const withExcl = scoreEmotionalResonance('開心！！');
    expect(withExcl).toBeGreaterThan(base);
  });

  it('boosts for emojis', () => {
    const base = scoreEmotionalResonance('good');
    const withEmoji = scoreEmotionalResonance('good 🎉🎊');
    expect(withEmoji).toBeGreaterThan(base);
  });

  it('caps at 1.0', () => {
    // Stack many signals to overflow
    const score = scoreEmotionalResonance(
      '開心 感謝 愛 喜歡 好棒 厲害 感動 謝謝 幸福 快樂 棒 讚 很好 ' +
      'happy love great thank wonderful amazing ' +
      '難過 擔心 害怕 生氣 失望！！！🎉🎊🎃',
    );
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe('Memory Quality — Identity Relevance', () => {
  it('scores 0 for non-identity content', () => {
    const score = scoreIdentityRelevance('the weather is nice today');
    expect(score).toBe(0);
  });

  it('detects identity keywords', () => {
    const score = scoreIdentityRelevance('我的名字叫做阿翔，生日在二月');
    expect(score).toBeGreaterThan(0.2);
  });

  it('boosts for "我是" statements', () => {
    const score = scoreIdentityRelevance('我是一個工程師');
    expect(score).toBeGreaterThan(0.25);
  });

  it('boosts for decision words', () => {
    const score = scoreIdentityRelevance('我決定要學 TypeScript');
    expect(score).toBeGreaterThan(0.2);
  });

  it('caps at 1.0', () => {
    const score = scoreIdentityRelevance(
      '我是 名字 生日 喜歡 討厭 偏好 習慣 工作 家 朋友 興趣 個性 我的 ' +
      '決定 選擇 i am name birthday prefer',
    );
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe('Memory Quality — Practical Value', () => {
  it('has baseline score for any content', () => {
    const score = scorePracticalValue('hello');
    expect(score).toBeGreaterThanOrEqual(0.1);
  });

  it('boosts for technical content', () => {
    const score = scorePracticalValue('Run the command: npm install');
    expect(score).toBeGreaterThan(0.3);
  });

  it('boosts for how-to content', () => {
    const score = scorePracticalValue('步驟一：如何安裝 Node.js');
    expect(score).toBeGreaterThan(0.3);
  });

  it('boosts for dates', () => {
    const score = scorePracticalValue('會議日期是 2026-02-13');
    expect(score).toBeGreaterThan(0.2);
  });

  it('boosts for URLs', () => {
    const base = scorePracticalValue('Documentation about something');
    const withUrl = scorePracticalValue('Documentation: https://example.com/docs');
    expect(withUrl).toBeGreaterThan(base);
  });

  it('boosts for longer content', () => {
    const short = scorePracticalValue('hi');
    const long = scorePracticalValue('a'.repeat(300));
    expect(long).toBeGreaterThan(short);
  });

  it('caps at 1.0', () => {
    const score = scorePracticalValue(
      'how to deploy the api function config 步驟 怎麼 如何 2026-02-13 https://example.com ' +
      'a'.repeat(600),
    );
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe('Memory Quality — Uniqueness', () => {
  it('returns 1 for first item (no existing)', () => {
    expect(scoreUniqueness('anything', [])).toBe(1);
  });

  it('returns low score for duplicate content', () => {
    const existing = ['the cat sat on the mat'];
    const score = scoreUniqueness('the cat sat on the mat', existing);
    expect(score).toBeLessThan(0.3);
  });

  it('returns high score for novel content', () => {
    const existing = ['the cat sat on the mat'];
    const score = scoreUniqueness('quantum computing research advances', existing);
    expect(score).toBeGreaterThan(0.7);
  });

  it('checks against all existing items', () => {
    const existing = [
      'TypeScript is a typed language',
      'JavaScript runs in the browser',
      'Python is great for data science',
    ];
    // Something similar to an existing item
    const score = scoreUniqueness('TypeScript is a strongly typed programming language', existing);
    expect(score).toBeLessThan(0.8);
  });
});

describe('Memory Quality — Composite Score', () => {
  it('returns all 4 dimensions plus composite', () => {
    const result = computeQualityScore('hello world');
    expect(result).toHaveProperty('emotional');
    expect(result).toHaveProperty('identity');
    expect(result).toHaveProperty('practical');
    expect(result).toHaveProperty('uniqueness');
    expect(result).toHaveProperty('composite');
  });

  it('composite is weighted average of dimensions', () => {
    const result = computeQualityScore('我很開心學會了如何設定 API');
    // composite = 0.25*emotional + 0.25*identity + 0.30*practical + 0.20*uniqueness
    const expected =
      0.25 * result.emotional +
      0.25 * result.identity +
      0.30 * result.practical +
      0.20 * result.uniqueness;
    expect(result.composite).toBeCloseTo(expected, 5);
  });

  it('emotional content gets high emotional dimension', () => {
    const result = computeQualityScore('謝謝你！我好開心好感動！！');
    expect(result.emotional).toBeGreaterThan(0.3);
  });

  it('technical content gets high practical dimension', () => {
    const result = computeQualityScore('步驟：用 command npm install 安裝 api function');
    expect(result.practical).toBeGreaterThan(0.4);
  });
});

describe('Memory Quality — Quality Adjusted Score', () => {
  it('blends base score with quality at default ratio (0.3)', () => {
    const result = qualityAdjustedScore(0.8, 0.6);
    // 0.7 * 0.8 + 0.3 * 0.6 = 0.56 + 0.18 = 0.74
    expect(result).toBeCloseTo(0.74, 5);
  });

  it('with ratio 0 returns pure base score', () => {
    expect(qualityAdjustedScore(0.8, 0.2, 0)).toBeCloseTo(0.8, 5);
  });

  it('with ratio 1 returns pure quality score', () => {
    expect(qualityAdjustedScore(0.8, 0.2, 1)).toBeCloseTo(0.2, 5);
  });

  it('custom ratio blends correctly', () => {
    const result = qualityAdjustedScore(1.0, 0.5, 0.5);
    // 0.5 * 1.0 + 0.5 * 0.5 = 0.75
    expect(result).toBeCloseTo(0.75, 5);
  });
});
