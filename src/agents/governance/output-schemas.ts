/**
 * Structured output schemas for agent results.
 *
 * Each agent can have a zod schema defining its expected output format.
 * Validation is advisory in Phase 2 (log failures) and becomes a hard
 * gate in Phase 3 (block pipeline progression).
 *
 * Agents without a registered schema pass validation automatically
 * (backward-compatible).
 */

import { z } from 'zod';

// ── Per-Agent Schemas ────────────────────────────────────────────────

export const ExplorerOutputSchema = z.object({
  topic: z.string().min(1),
  findings: z
    .array(
      z.object({
        content: z.string().min(1),
        importance: z.number().min(1).max(5),
        source: z.string().optional(),
      }),
    )
    .min(1),
  importance: z.number().min(1).max(5),
  followUpQuestions: z.array(z.string()).optional(),
});

export const BlogWriterOutputSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(10),
  tags: z.array(z.string()).optional(),
  category: z.string().optional(),
});

export const HNDigestOutputSchema = z.object({
  stories: z
    .array(
      z.object({
        title: z.string(),
        url: z.string().optional(),
        score: z.number().optional(),
        summary: z.string(),
      }),
    )
    .min(1),
  trends: z.string().optional(),
});

export const SecurityScannerOutputSchema = z.object({
  findings: z.array(
    z.object({
      severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
      title: z.string(),
      description: z.string(),
      file: z.string().optional(),
      recommendation: z.string().optional(),
    }),
  ),
  overallRisk: z.enum(['critical', 'high', 'medium', 'low', 'none']),
});

// ── Registry ─────────────────────────────────────────────────────────

const OUTPUT_SCHEMA_REGISTRY: Record<string, z.ZodTypeAny> = {
  explorer: ExplorerOutputSchema,
  'blog-writer': BlogWriterOutputSchema,
  'hackernews-digest': HNDigestOutputSchema,
  'security-scanner': SecurityScannerOutputSchema,
};

// ── Validation ───────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  agentName: string;
  errors?: string[];
}

/**
 * Validate agent output against its registered schema.
 * Returns { valid: true } if no schema is registered (backward-compatible).
 */
export function validateAgentOutput(
  agentName: string,
  rawOutput: unknown,
): ValidationResult {
  const schema = OUTPUT_SCHEMA_REGISTRY[agentName];

  // No schema registered — pass through
  if (!schema) {
    return { valid: true, agentName };
  }

  // Try to parse the output as JSON if it's a string
  let parsed = rawOutput;
  if (typeof rawOutput === 'string') {
    try {
      parsed = JSON.parse(rawOutput);
    } catch {
      // Not JSON — try extracting JSON from markdown code blocks
      const jsonMatch = (rawOutput as string).match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[1]!);
        } catch {
          return {
            valid: false,
            agentName,
            errors: ['Output is not valid JSON and no JSON block found in markdown'],
          };
        }
      } else {
        // Free-text output — cannot validate against schema
        return {
          valid: false,
          agentName,
          errors: ['Output is plain text, expected structured JSON'],
        };
      }
    }
  }

  const result = schema.safeParse(parsed);
  if (result.success) {
    return { valid: true, agentName };
  }

  return {
    valid: false,
    agentName,
    errors: result.error.issues.map(
      (i) => `${i.path.join('.')}: ${i.message}`,
    ),
  };
}

/** Check if an agent has a registered output schema. */
export function hasOutputSchema(agentName: string): boolean {
  return agentName in OUTPUT_SCHEMA_REGISTRY;
}

/** Get all agent names that have output schemas. */
export function getSchemaAgentNames(): string[] {
  return Object.keys(OUTPUT_SCHEMA_REGISTRY);
}
