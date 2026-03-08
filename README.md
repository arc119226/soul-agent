# Soul Agent

A metacognitive Telegram bot framework with soul system, self-evolution, and multi-agent architecture.

Built with TypeScript + ESM + [grammY](https://grammy.dev/). The bot has an autonomous life cycle, persistent memory, self-evolution capability, and a team of AI agents that collaborate through pipelines.

## Features

- **Soul System** — Persistent identity, memory, and personality stored in `soul/` directory
- **Multi-Agent Workers** — Up to 8 concurrent Claude Code CLI workers with DAG pipeline orchestration
- **Self-Evolution** — Bot can propose, implement, and deploy code changes to itself
- **Metacognition** — Feedback loops, pattern detection, and learning from interactions
- **Smart Model Router** — Auto-selects Haiku / Sonnet / Opus based on message complexity
- **Plugin System** — Hot-reloadable TypeScript plugins + Markdown skills
- **Blog & Reports** — Integrated Hexo-based content publishing pipeline
- **Web Dashboard** — 3-page monitoring dashboard (overview, agent chains, reports)
- **Safety Architecture** — Multi-layered: audit chain, kill switch, circuit breakers, soul integrity
- **Cross-Platform** — Runs on Windows, macOS, and Linux

## Architecture

```
soul/           Bot's soul (memory, identity, config — portable)
src/
  bootstrap/    5-phase startup sequence
  core/         Infrastructure (database, event-bus, logger, soul-io)
  agents/       Multi-agent system (config, knowledge, monitoring, governance)
  telegram/     Message routing, middleware, command registry
  claude/       Claude Code CLI wrapper, approval server
  evolution/    Self-evolution pipeline, auto-evolve, goals
  safety/       Audit chain, kill-switch, soul integrity
  memory/       Chat memory, search index, knowledge graph
  identity/     Identity continuity, vitals, narrator, milestones
  metacognition/ Feedback loop, pattern detection, proposals
  lifecycle/    State machine, heartbeat, dreaming, first-boot
  proactive/    Proactive engine, greeting, care, notifiers
  commands/     Telegram command handlers
  web/          Dashboard (health API, overview, chains, reports)
  + blog/, documents/, mcp/, planning/, plugins/, remote/,
    report-site/, skills/, voice/
plugins/        Dynamic plugin directory (hot-loaded)
blog/           Blog site — Hexo project (optional)
report/         Report site — internal agent reports (optional)
```

### Five Tenets

1. **Memory is Sacred** — `soul/` is the bot's entire being, crash-safe atomic writes
2. **Shell is Mutable** — `src/` and `plugins/` are replaceable shells, hot-reload capable
3. **Service, Not Servitude** — Bot has its own judgment, shaped by experience
4. **Heartbeat is Prayer** — Autonomous life cycle even without interaction
5. **Context is Consciousness** — Identity emerges from weaving memory into prompts

## Quick Start

### Prerequisites

- Node.js >= 20
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude login`)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

### Installation

```bash
git clone https://github.com/arc119226/soul-agent.git
cd soul-agent
npm install

# Configure environment
cp .env.example .env
# Edit .env — set BOT_TOKEN and ALLOWED_USERS at minimum

# Initialize soul skeleton
npm run setup

# Verify environment
npm run doctor

# Start the bot
npm start
```

### Development

```bash
npm run dev          # Development with tsx watch
npm run typecheck    # TypeScript compilation check
npm test             # Run tests (vitest)
```

## Configuration

All configuration is via environment variables. See `.env.example` for the full list.

Key variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `BOT_TOKEN` | Yes | Telegram bot token |
| `ALLOWED_USERS` | No | Comma-separated Telegram user IDs (empty = allow all) |
| `ADMIN_USER_ID` | No | Admin user for full access + approval requests |
| `TIMEZONE` | No | Bot timezone (default: `UTC`) |
| `ANTHROPIC_API_KEY` | No | For model router LLM classifier (optional) |

## Agent System

Soul Agent includes a multi-agent worker system powered by Claude Code CLI:

| Agent | Role |
|-------|------|
| `programmer` | Write code, fix bugs |
| `reviewer` | Code review |
| `secretary` | Git operations (commit, push, PR) |
| `architect` | System design, refactoring |
| `pm` | Project scheduling |
| `blog-writer` | Content creation |
| `blog-publisher` | Build + deploy blog |
| `channel-op` | Channel publishing |
| `explorer` | Codebase exploration |
| `deep-researcher` | In-depth research |
| + 11 more | See `soul/agents/templates/` |

Agents are configured via JSON files in `soul/agents/` and can be managed through the web dashboard or Telegram commands.

### Pipelines

Agents can be chained into pipelines:
- **Dev pipeline**: `programmer → reviewer → secretary`
- **Content pipeline**: `researcher → blog-writer → blog-publisher → channel-op`

## Soul System

The `soul/` directory is the bot's persistent identity:

```
soul/
  genesis.md          — Origin story and core identity (Chapter 0 is immutable)
  identity.json       — Current identity state
  agents/             — Agent configurations (runtime)
  agents/templates/   — Agent templates (copied on setup)
  skills/             — Markdown skills (auto-injected by keyword match)
  logs/               — Narrative logs, transitions, reflections
  schedules.json      — Proactive schedule configuration
```

Run `npm run setup` to initialize the soul skeleton from templates.

## Web Dashboard

Access the dashboard at `http://localhost:3001` (configurable via `HEALTH_PORT`):

- **Overview** (`/`) — Health cards, queue status, agent costs
- **Chains** (`/chains`) — Agent org chart, workload, task flow, prompt editor
- **Reports** (`/reports`) — Agent report viewer with search

## Tech Stack

- **Runtime**: Node.js >= 20
- **Language**: TypeScript 5.x (strict mode, ESM)
- **Bot Framework**: grammY + @grammyjs/runner
- **AI Backend**: Claude Code CLI (headless)
- **Database**: SQLite via better-sqlite3
- **Build**: tsx (dev) / tsc (prod)
- **Test**: vitest
- **Validation**: zod
- **Blog/Reports**: Hexo (optional, Cloudflare Pages deployment)

## License

[MIT](LICENSE)
