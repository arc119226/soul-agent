# Contributing to Soul Agent

Thank you for your interest in contributing! This guide will help you get started.

## Development Setup

```bash
git clone https://github.com/arc119226/soul-agent.git
cd soul-agent
npm install
cp .env.example .env   # Configure your environment
npm run setup           # Initialize soul skeleton
npm run doctor          # Verify environment
```

## Code Style

- **ESM** (`import`/`export`) throughout — `"type": "module"` in package.json
- **Result<T>** pattern for operation outcomes in `evolution/`, `safety/`, `documents/` modules
- Use `throw` in `telegram/` and `commands/` (grammY convention)
- Use `soul-io.ts` helpers (`readSoulJson`, `writeSoulJson`, etc.) for all `soul/` file access
- Atomic writes for all `soul/` data

## Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): description

Examples:
feat(agents): add new agent type
fix(memory): prevent duplicate entries
perf(lifecycle): reduce heartbeat interval
docs: update README
chore: bump dependencies
```

## Testing

```bash
npm test              # Run all tests
npm run typecheck     # TypeScript compilation check
```

- Test framework: vitest
- Mock external I/O in tests
- Use `vi.mock()` at top level

## Pull Requests

1. Fork the repo and create a feature branch
2. Make your changes
3. Ensure `npm run typecheck` and `npm test` pass
4. Submit a PR with a clear description

## Project Structure

See [README.md](README.md) for the full directory structure. Key patterns:

- `src/core/` — Infrastructure (don't modify lightly)
- `src/agents/` — Agent system
- `plugins/` — Hot-reloadable plugins (good place to start contributing)
- `soul/skills/` — Markdown skills
- `tests/` — Unit and integration tests

## Soul Protection Rules

The evolution system **must never** auto-modify:
- `soul/` directory contents
- `src/memory/`
- `src/identity/`
- `genesis.md` Chapter 0 (immutable)

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
