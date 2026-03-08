import { readSoulFile } from '../core/soul-io.js';
import { ok, fail, type Result } from '../result.js';
const CHAPTER_SEPARATOR = '\n---\n';

/**
 * Split genesis document into Chapter 0 (immutable) and later chapters.
 * Chapter 0 is everything before the first "---" separator line.
 */
function splitChapters(content: string): { chapter0: string; rest: string } {
  const idx = content.indexOf(CHAPTER_SEPARATOR);
  if (idx === -1) {
    // No separator found — the entire document is Chapter 0
    // Also check for a trailing --- at the end
    const trailingIdx = content.indexOf('\n---');
    if (trailingIdx === -1) {
      return { chapter0: content, rest: '' };
    }
    return { chapter0: content.slice(0, trailingIdx + 4), rest: content.slice(trailingIdx + 4) };
  }
  return {
    chapter0: content.slice(0, idx + CHAPTER_SEPARATOR.length),
    rest: content.slice(idx + CHAPTER_SEPARATOR.length),
  };
}

/**
 * Validate a proposed modification to the genesis document.
 * Rules:
 * - Chapter 0 (before first "---") is IMMUTABLE
 * - Later chapters can be appended but existing chapters cannot be modified
 */
export async function validateGenesisModification(
  proposed: string,
): Promise<Result> {
  let original: string;
  try {
    original = await readSoulFile('genesis.md');
  } catch {
    return fail('Cannot read genesis document for validation');
  }

  const originalParts = splitChapters(original);
  const proposedParts = splitChapters(proposed);

  // Chapter 0 must be identical
  if (proposedParts.chapter0 !== originalParts.chapter0) {
    return fail(
      'Chapter 0 of genesis is immutable',
      'The content before the first "---" separator in soul/genesis.md cannot be modified. ' +
        'This is the creator\'s original word and is sacred.',
    );
  }

  // Existing later chapters must not be modified (only append is allowed)
  if (originalParts.rest.length > 0) {
    if (!proposedParts.rest.startsWith(originalParts.rest)) {
      return fail(
        'Existing chapters cannot be modified',
        'You can only append new chapters to genesis.md. Existing chapters after Chapter 0 must remain unchanged.',
      );
    }
  }

  return ok('Genesis modification is valid (append only)');
}

/** Get the immutable Chapter 0 content */
export async function getChapter0(): Promise<string> {
  try {
    const content = await readSoulFile('genesis.md');
    const { chapter0 } = splitChapters(content);
    return chapter0;
  } catch {
    return '';
  }
}

/** Get the full genesis document */
export async function getGenesis(): Promise<string> {
  try {
    return await readSoulFile('genesis.md');
  } catch {
    return '';
  }
}
