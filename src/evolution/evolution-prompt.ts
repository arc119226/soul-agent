/**
 * Evolution prompt assembly — builds the prompt for Claude Code
 * to execute an evolution step.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getCapabilities } from './capabilities.js';
import { getRecentChanges } from './changelog.js';
import type { Goal } from './goals.js';
import { logger } from '../core/logger.js';

const PROJECT_ROOT = process.cwd();
const CLAUDE_MD = join(PROJECT_ROOT, 'CLAUDE.md');

const SAFETY_RULES = `
## SAFETY RULES — ABSOLUTE CONSTRAINTS
1. NEVER modify any file under soul/ directory — it is the bot's sacred memory
2. NEVER modify src/memory/ — memory system integrity must be preserved
3. NEVER modify src/identity/ — identity is core to the bot's being
4. NEVER delete or overwrite .env or any credential files
5. NEVER introduce dependencies without explicit justification
6. Always use ESM imports with .js extensions
7. Always use the Result<T> pattern for fallible operations
8. All file writes to soul/ must use atomic operations (DebouncedWriter)
9. Maintain backward compatibility with existing plugin API
10. Never remove existing exports that other modules depend on
`.trim();

const FILE_GUIDELINES = `
## FILE CHANGE GUIDELINES
- Create new files in the appropriate src/ subdirectory
- Follow existing code patterns (see CLAUDE.md Key Patterns)
- Use TypeScript strict mode compatible code
- Export types and interfaces explicitly
- Keep functions focused and single-purpose
- Add error handling with Result<T> for operations that can fail
- Use the logger for important operations
- Use EventBus for cross-module communication
`.trim();

const TYPESCRIPT_CONTEXT = `
## TYPESCRIPT CONFIGURATION (tsconfig.json)
This project uses strict TypeScript with the following critical settings:
- \`strict: true\` — enables strictNullChecks, strictFunctionTypes, etc.
- \`noUncheckedIndexedAccess: true\` — array/object index access returns \`T | undefined\`
- \`module: "NodeNext"\` + \`moduleResolution: "NodeNext"\` — ESM with .js extensions required
- \`target: ES2022\` — modern JS features supported

### COMMON TYPE ERRORS TO AVOID

**noUncheckedIndexedAccess — most common failure cause:**
\`\`\`typescript
// ❌ WRONG — arr[0] is string | undefined, not string
const first: string = arr[0];
someArr[i].doSomething();

// ✅ CORRECT — use non-null assertion, optional chain, or guard
const first = arr[0]!;           // assert non-null (use when sure)
arr[0]?.doSomething();           // optional chain (safe)
const val = arr[i]; if (val !== undefined) { val.doSomething(); }  // guard
\`\`\`

**Dynamic import in ESM:**
\`\`\`typescript
// ✅ CORRECT — always use .js extension in imports (even for .ts files)
import { foo } from './my-module.js';
const mod = await import('./my-module.js');
\`\`\`

**Result<T> pattern (used throughout this codebase):**
\`\`\`typescript
import { ok, fail, type Result } from '../result.js';
async function doWork(): Promise<Result<string>> {
  try {
    return ok('success message', value);
  } catch (err) {
    return fail(\`Error: \${err instanceof Error ? err.message : String(err)}\`);
  }
}
// Usage:
const result = await doWork();
if (!result.ok) { logger.error('X', result.error); return; }
const value = result.value;
\`\`\`

**Verify with:** \`npx tsgo --noEmit\` (faster than npx tsc --noEmit)
`.trim();

export interface PromptContext {
  knowledgeSnippets?: string[];
  recentErrors?: string[];
  additionalInstructions?: string;
}

/** Build the full evolution prompt for Claude Code */
export async function buildEvolutionPrompt(
  goal: Goal,
  context: PromptContext = {},
): Promise<string> {
  const sections: string[] = [];

  // 1. Task description
  sections.push(`# Evolution Task`);
  sections.push(`Goal ID: ${goal.id}`);
  sections.push(`Description: ${goal.description}`);
  sections.push(`Priority: ${goal.priority}/5`);
  sections.push(`Tags: ${goal.tags.join(', ') || 'none'}`);
  sections.push('');

  // 2. Safety rules
  sections.push(SAFETY_RULES);
  sections.push('');

  // 3. File guidelines
  sections.push(FILE_GUIDELINES);
  sections.push('');

  // 3.5 TypeScript configuration context (prevents common type-check failures)
  sections.push(TYPESCRIPT_CONTEXT);
  sections.push('');

  // 4. Current capabilities
  const caps = getCapabilities();
  if (caps) {
    sections.push('# Current Capabilities');
    sections.push(caps);
    sections.push('');
  }

  // 5. CLAUDE.md content (project context)
  try {
    const claudeMd = await readFile(CLAUDE_MD, 'utf-8');
    sections.push('# Project Context (CLAUDE.md)');
    sections.push(claudeMd);
    sections.push('');
  } catch {
    logger.warn('prompt-builder', 'Could not read CLAUDE.md');
  }

  // 6. Knowledge snippets from web or docs
  if (context.knowledgeSnippets && context.knowledgeSnippets.length > 0) {
    sections.push('# Relevant Knowledge');
    for (const snippet of context.knowledgeSnippets) {
      sections.push(snippet);
    }
    sections.push('');
  }

  // 7. Recent evolution history for context
  try {
    const recentChanges = await getRecentChanges(5);
    if (recentChanges.length > 0) {
      sections.push('# Recent Evolution History');
      for (const change of recentChanges) {
        const status = change.success ? 'SUCCESS' : 'FAILED';
        sections.push(`- [${status}] ${change.description}`);
        if (change.lessonsLearned) {
          sections.push(`  Lesson: ${change.lessonsLearned}`);
        }
      }
      sections.push('');
    }
  } catch {
    // Non-critical
  }

  // 7.5. Curiosity & learning direction
  try {
    const { getCuriosityTopics } = await import('../metacognition/curiosity.js');
    const topics = await getCuriosityTopics();
    if (topics.length > 0) {
      sections.push('# Curiosity & Learning Direction');
      for (const t of topics.slice(0, 5)) {
        sections.push(`- ${t.topic} (${t.reason})`);
      }
      sections.push('');
    }
  } catch { /* Non-critical */ }

  // 8. Recent errors to learn from
  if (context.recentErrors && context.recentErrors.length > 0) {
    sections.push('# Recent Errors to Avoid');
    for (const err of context.recentErrors) {
      sections.push(`- ${err}`);
    }
    sections.push('');
  }

  // 9. Additional instructions
  if (context.additionalInstructions) {
    sections.push('# Additional Instructions');
    sections.push(context.additionalInstructions);
    sections.push('');
  }

  // 10. Output format
  sections.push('# Expected Output');
  sections.push('Implement the goal described above. After making changes:');
  sections.push('1. List all files you created or modified');
  sections.push('2. Describe what each change does');
  sections.push('3. Note any lessons learned or edge cases discovered');
  sections.push('4. Confirm the changes compile with `npx tsgo --noEmit`');

  return sections.join('\n');
}
