/** Lightweight Result type — Ok/Fail pattern */

export interface Ok<T = undefined> {
  ok: true;
  value: T;
  message: string;
}

export interface Fail {
  ok: false;
  error: string;
  fixHint?: string;
}

export type Result<T = undefined> = Ok<T> | Fail;

export function ok<T = undefined>(message: string, value?: T): Ok<T> {
  return { ok: true, value: value as T, message };
}

export function fail(error: string, fixHint?: string): Fail {
  return { ok: false, error, fixHint };
}

export function isOk<T>(result: Result<T>): result is Ok<T> {
  return result.ok;
}

export function isFail(result: Result<unknown>): result is Fail {
  return !result.ok;
}

export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw new Error(result.error);
}
