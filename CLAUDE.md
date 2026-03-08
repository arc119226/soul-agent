# CLAUDE.md — Soul Agent Project Guide

## Project Overview
Metacognitive Telegram Bot with soul system, self-evolution, and multi-agent architecture.
TypeScript + ESM + grammY framework. Bot has autonomous life cycle, memory persistence, and self-evolution capability.

## Quick Start
```bash
git clone https://github.com/arc119226/soul-agent.git
npm install            # Installs all dependencies (main + blog/ + report/)
cp .env.example .env   # Fill in BOT_TOKEN and ALLOWED_USERS
npm run setup          # Generates soul/ skeleton files + .mcp.json
npm run doctor         # Verify environment health
npm start              # Uses restart.ts wrapper (auto-restart on exit code 42)
npm run dev            # Development with tsx watch
```

## Architecture — Five Tenets
1. **Memory is Sacred** — soul/ is the bot's entire being, crash-safe atomic writes
2. **Shell is Mutable** — src/ and plugins/ are replaceable shells, hot-reload capable
3. **Service, Not Servitude** — Bot has its own judgment, shaped by experience
4. **Heartbeat is Prayer** — Autonomous life cycle even without interaction
5. **Context is Consciousness** — Identity emerges from weaving memory into prompts

## Directory Structure
```
soul/     — Bot's soul (memory, identity, config — platform-agnostic, portable)
src/      — Source code (the shell):
  bootstrap/  — Startup sequence phases (phase1-soul, phase2-bot, phase3-subsystems, phase4-startup, shutdown)
  core/       — Infrastructure (database, event-bus, logger, soul-io, schedule-engine, etc.)
  agents/     — Agent system (config/, knowledge/, monitoring/, governance/)
  telegram/   — Message routing, middleware, command registry
  claude/     — Claude Code CLI wrapper, approval server
  evolution/  — Self-evolution pipeline, auto-evolve, goals
  safety/     — Audit chain, kill-switch, soul integrity
  memory/     — Chat memory, search index, knowledge graph
  identity/   — Identity continuity, vitals, narrator, milestones
  metacognition/ — Feedback loop, pattern detection, proposals
  lifecycle/  — State machine, heartbeat, dreaming, first-boot
  proactive/  — Proactive engine, greeting, care, notifiers
  commands/   — Telegram command handlers
  web/        — Dashboard (health API, overview, chains, reports)
  + remote/, documents/, blog/, report-site/, mcp/, voice/, planning/, skills/, plugins/
plugins/  — Dynamic plugin directory (hot-loaded)
blog/     — Blog site — Hexo project (optional)
report/   — Report site — internal agent reports (optional)
data/     — Runtime transient data (not soul)
```

## Key Patterns
- **ESM** (`import`/`export`) throughout, `"type": "module"` in package.json
- **Result<T>** pattern for operation outcomes (Ok/Fail, not exceptions):
  - **Must use**: `evolution/`, `safety/`, `documents/` — all public functions return `Result<T>`
  - **Must use throw**: `telegram/` (grammY framework convention) and `commands/` (handler signatures)
  - **Recommended**: new code in other modules should prefer `Result<T>` over try-catch
  - Definition: `src/result.ts` exports `Ok<T>`, `Fail`, `Result<T>`
- **Soul I/O** — `src/core/soul-io.ts`: centralized soul/ path construction and file access. Use `getSoulPath()`, `readSoulJson<T>()`, `readSoulFile()`, `writeSoulJson()`, `scheduleSoulJson()`, `appendSoulJsonl()`, `soulExists()`, `listSoulDir()` instead of raw `join(process.cwd(), 'soul', ...)` + `readFile`
- **Atomic writes** for all soul/ data (write → tmp → rename) via `DebouncedWriter` or soul-io wrappers
- **JSONL append-only** for event streams (narrative, changelog, reflections)
- **Concurrent polling** via `@grammyjs/runner` — `/commands` respond instantly even while CLI is busy
- **Per-chat queue** serializes Claude CLI calls per chatId
- **Plugin hot-reload** via file-copy cache busting (timestamp in filename)
- **Markdown Skills** — knowledge-level extensions in soul/skills/*.md, self-manageable via MCP tools
- **Type-safe EventBus** for inter-module communication (43 event types in `src/core/event-bus.ts`)
- **Timezone-aware dates** — use `getTodayString()` from `src/core/timezone.ts` for "today" comparisons
- **In-memory caches** for hot-path I/O: `configCache` (TTL=30s), `queueCache` (TTL=5s), `reportsCache` (TTL=60s) in agent subsystem — invalidated on write
- **tailRead** — `src/core/tail-read.ts`: seek-from-end JSONL reading, avoids loading entire files. Use `tailReadJsonl<T>()` instead of `readFile` for JSONL tails

## Startup Sequence (Bootstrap)
Entry point `src/index.ts` orchestrates 5 phases, each in `src/bootstrap/`:
1. **phase1-soul.ts** — Soul verification, DB init, identity/vitals loading, integrity checks, auth preflight (fatal on core failure)
2. **phase2-bot.ts** — Bot creation, middleware, commands, message handler, document handler
3. **shutdown.ts** — LIFO shutdown handlers: stop-bot → flush-and-seal → close-database
4. **phase3-subsystems.ts** — Non-critical: metrics, narrative listener, feedback loop, agents, plugins, skills, memory index, health API, approval server, cost anomaly detector, state machine, ELU, heartbeat
5. **phase4-startup.ts** — Telegram polling, first boot, proactive engine, evolution, worker scheduler, report sync, online notification

Each phase is independently testable and has isolated failure domains.

## Exit Code Semantics
| Code | Meaning | Wrapper Behavior |
|------|---------|-----------------|
| 0    | Sleep (shutdown) | Stop, wait for manual start |
| 42   | Molt (restart) | Auto-restart after 2s |
| 1    | Error | Stop, needs manual intervention |

## Soul Protection Rules
- Evolution system **MUST NEVER** auto-modify: soul/, src/memory/, src/identity/
- genesis.md chapter 0 is immutable (creator's words)
- All soul/ writes use atomic operations
- Git tag + soul snapshot before every evolution attempt

## Safety Architecture
Multi-layered: Soul Guard, Audit Chain (Merkle + hash-chain `transitions.jsonl` + vector clock), Kill Switch (3-level), Circuit Breakers (evolution + worker), Identity Continuity.
- **Dual circuit breakers**: Evolution CB (3 failures → 6h cooldown) + Worker CB (5 transient failures → 30min cooldown)
- **Z-score anomaly detection** (`anomaly-detector.ts`): rolling window=30, auto-adaptive baselines
- **Cost anomaly detector** (`cost-anomaly.ts`): per-agent Z-score on `cost:incurred` events

## Smart Model Router
Auto-selects Haiku / Sonnet / Opus per message complexity (`src/telegram/model-router.ts`).
Prefixes: `~`=Opus, `?`=Sonnet, `/`=command.

## Command System
Commands in `src/commands/`, bound via `command-registry.ts`. See `commands.txt` for full list.
- **Single source of truth**: categories in `src/commands/menu.ts` CATEGORIES
- Adding a command: register → add to `menu.ts` CATEGORIES + `commands.txt`

## Extension System
Two-tier: **TS plugins** (`plugins/*.ts`, hot-reload) + **MD skills** (`soul/skills/*.md`, keyword match → auto-inject).
Skill CRUD via MCP tools.

## Multi-Agent Workers
Up to 8 concurrent CLI workers, DAG pipeline, cost tracking, LLM-as-Judge, durable execution.
- **Horizontal dispatch**: agents can `dispatch_task` to other agents (chain depth ≤ 5, chain cost ≤ $10)
- **HANDOFF auto-dispatch**: tasks parse `---HANDOFF---` directives on completion and auto-enqueue downstream agents
- **Worktree isolation**: code agents run in isolated git worktrees; enables parallel execution
- **Dev pipeline**: `programmer → reviewer → secretary` (code → review → commit+push via PR)
- **Content pipeline**: `research agents → blog-writer → blog-publisher → channel-op`
- **Scheduling**: `soul/agents/*.json` `schedule` field + `soul/schedules.json` (proactive)
- **KB auto-internalization**: promotes high-value knowledge base rules into agent system prompts
- **Shared knowledge**: cross-agent knowledge distillation with dedup and injection budget
- **Output schemas**: Zod schemas per agent type with advisory/blocking validation modes
- **Worker circuit breaker**: prevents cascade failures when Claude API is degraded
- **DLQ consumer**: automatic retry of failed tasks from Dead Letter Queue
- **Cost anomaly detection**: per-agent Z-score alerting with auto-pause
- **Dashboard** (`src/web/`): 3-page dashboard (overview, agent chains, reports)

## Testing & CI
- **Framework**: vitest. Pre-commit: `tsc --noEmit`. Pre-push: `npm test`.
- **Conventions**: mock external I/O, `vi.mock()` at top level, isolate from disk state

## Environment Variables
See `.env.example` for all options. Key ones:
- `BOT_TOKEN` (required) — Telegram bot token
- `ALLOWED_USERS` — Comma-separated user IDs
- `ADMIN_USER_ID` — Admin user for full access
- `TIMEZONE` — Bot timezone (default: UTC)

## Tech Stack
- Runtime: Node.js >= 20
- Language: TypeScript 5.x (strict mode)
- Bot: grammY + @grammyjs/runner
- AI: Claude Code CLI (headless)
- Build: tsx (dev) / tsc (prod)
- Test: vitest
- Validation: zod
