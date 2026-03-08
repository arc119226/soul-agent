/**
 * Tests for truncateWithMarker — SPEC-01: Pipeline Context Truncation Transparency.
 *
 * Verifies that:
 *   - Text within budget passes through unchanged
 *   - Text exceeding budget is truncated with a visible [TRUNCATED: ...] marker
 *   - The marker includes dropped character count and original length
 */

import { describe, it, expect } from 'vitest';
import { truncateWithMarker, PIPELINE_CONTEXT_CAP } from '../../src/agents/truncate-utils.js';

describe('truncateWithMarker', () => {
  it('returns text unchanged when within budget', () => {
    const text = 'short text';
    const result = truncateWithMarker(text, 100);
    expect(result).toBe(text);
  });

  it('returns text unchanged when exactly at budget', () => {
    const text = 'a'.repeat(3000);
    const result = truncateWithMarker(text, 3000);
    expect(result).toBe(text);
  });

  it('truncates and appends marker when text exceeds budget', () => {
    const text = 'a'.repeat(5000);
    const result = truncateWithMarker(text, 3000);

    expect(result).toContain('[TRUNCATED:');
    expect(result).toContain('2000 characters omitted');
    expect(result).toContain('Original length: 5000');
    // The first 3000 chars should be preserved
    expect(result.startsWith('a'.repeat(3000))).toBe(true);
  });

  it('includes correct dropped count in marker', () => {
    const text = 'x'.repeat(10000);
    const budget = 4000;
    const result = truncateWithMarker(text, budget);

    const expectedDropped = 10000 - 4000;
    expect(result).toContain(`${expectedDropped} characters omitted`);
    expect(result).toContain(`Original length: ${text.length}`);
  });

  it('handles empty text', () => {
    const result = truncateWithMarker('', 3000);
    expect(result).toBe('');
  });

  it('handles budget of 0', () => {
    const text = 'some content';
    const result = truncateWithMarker(text, 0);
    expect(result).toContain('[TRUNCATED:');
    expect(result).toContain(`${text.length} characters omitted`);
  });

  it('does not add marker for no-truncation case', () => {
    const text = 'hello world';
    const result = truncateWithMarker(text, 1000);
    expect(result).not.toContain('[TRUNCATED:');
  });
});

describe('PIPELINE_CONTEXT_CAP default', () => {
  it('is 3000', () => {
    expect(PIPELINE_CONTEXT_CAP).toBe(3000);
  });
});
