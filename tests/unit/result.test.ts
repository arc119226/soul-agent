import { describe, it, expect } from 'vitest';
import { ok, fail, isOk, isFail, unwrap } from '../../src/result.js';

describe('Result type', () => {
  it('ok creates a successful result', () => {
    const result = ok('success', 42);
    expect(result.ok).toBe(true);
    expect(result.message).toBe('success');
    expect(result.value).toBe(42);
  });

  it('ok without value defaults to undefined', () => {
    const result = ok('done');
    expect(result.ok).toBe(true);
    expect(result.value).toBeUndefined();
  });

  it('fail creates a failure result', () => {
    const result = fail('error message', 'try X');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('error message');
    expect(result.fixHint).toBe('try X');
  });

  it('isOk and isFail type guards work correctly', () => {
    const success = ok('yes', 1);
    const failure = fail('no');

    expect(isOk(success)).toBe(true);
    expect(isFail(success)).toBe(false);
    expect(isOk(failure)).toBe(false);
    expect(isFail(failure)).toBe(true);
  });

  it('unwrap returns value on Ok', () => {
    const result = ok('success', 'hello');
    expect(unwrap(result)).toBe('hello');
  });

  it('unwrap throws on Fail', () => {
    const result = fail('bad');
    expect(() => unwrap(result)).toThrow('bad');
  });
});
