import { z } from 'zod';
import { config as loadDotenv } from 'dotenv';

loadDotenv();

const commaSeparatedNumbers = z
  .string()
  .default('')
  .transform((s) => s.split(',').filter(Boolean).map(Number));

const optionalString = z.string().default('');
const optionalNumber = (def: number) =>
  z.coerce.number().default(def);
const optionalBool = (def: boolean) =>
  z
    .string()
    .default(String(def))
    .transform((v) => v === 'true' || v === '1');

const configSchema = z.object({
  // Core
  BOT_TOKEN: z.string().min(1, 'BOT_TOKEN is required'),
  ALLOWED_USERS: commaSeparatedNumbers,
  ADMIN_USER_ID: z.coerce.number().default(0),
  BOT_PERSONA: optionalString,

  // Claude Code
  CLAUDE_CODE_CWD: optionalString,
  CLAUDE_CODE_TIMEOUT: optionalNumber(300_000),
  CLAUDE_CODE_MODEL: optionalString,
  CLAUDE_CODE_MAX_TURNS: optionalNumber(0),

  // Approval
  APPROVAL_PORT: optionalNumber(3691),
  APPROVAL_CHAT_ID: z.coerce.number().default(0),
  APPROVAL_TIMEOUT: optionalNumber(120_000),

  // Rate limiting
  DAILY_REQUEST_LIMIT: optionalNumber(0),

  // Memory
  MAX_CONTEXT_MESSAGES: optionalNumber(30),
  USER_FACT_LIMIT: optionalNumber(20),

  // Evolution
  KNOWLEDGE_URLS: z
    .string()
    .default('')
    .transform((s) => s.split(',').filter(Boolean)),
  MAX_AUTO_EVOLVES_PER_DAY: optionalNumber(3),
  AUTO_RESTART_AFTER_EVOLVE: optionalBool(false),
  EVOLVE_TRUST_MODE: optionalBool(false),
  AUTO_PUSH_ENABLED: optionalBool(false),
  AUTO_PUSH_REQUIRE_APPROVAL: z.enum(['never', 'high', 'medium', 'all']).default('high'),
  EVOLUTION_PRE_CHECK_STRICT: optionalBool(false),

  // Model routing tiers
  MODEL_TIER_HAIKU: z.string().default('claude-haiku-4-5-20251001'),
  MODEL_TIER_SONNET: z.string().default('claude-sonnet-4-6'),
  MODEL_TIER_OPUS: optionalString, // empty = use CLI default

  // Lifecycle
  TIMEZONE: z.string().default('Asia/Taipei'),
  QUIET_HOURS_START: optionalNumber(23),
  QUIET_HOURS_END: optionalNumber(7),

  // Health API
  HEALTH_API_PORT: optionalNumber(0), // 0 = disabled

  // Skill upgrade advisor
  UPGRADE_CHECK_SCHEDULE: z.string().default('daily@09:00'),

  // Channel publishing
  TELEGRAM_CHANNEL_ID: z.string().default(''),

  // Business identity URLs
  BLOG_URL: z.string().url().default('https://blog.example.com'),
  REPORT_URL: z.string().url().default('https://report.example.com'),

  // Cloudflare Pages project names
  CF_BLOG_PROJECT: z.string().default('my-blog'),
  CF_REPORT_PROJECT: z.string().default('my-report'),
});

export type Config = z.infer<typeof configSchema>;

function loadConfig(): Config {
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    const errors = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    console.error(`Configuration errors:\n${errors}`);
    process.exit(1);
  }
  return result.data;
}

export const config = loadConfig();
