/** Max characters of per-stage context included in pipeline prompts (default) */
export const PIPELINE_CONTEXT_CAP = 3000;

/**
 * Truncate text with a visible marker so downstream agents know data was lost.
 * If text fits within budget, returns it unchanged.
 */
export function truncateWithMarker(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const truncated = text.slice(0, budget);
  const droppedChars = text.length - budget;
  return `${truncated}\n\n[TRUNCATED: ${droppedChars} characters omitted. Original length: ${text.length}]`;
}
