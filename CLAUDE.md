# CLAUDE.md — Prism

## What This Is
An intelligent LLM arena + router. Race frontier models against each other, build a personal preference profile, then auto-route in production.

## Why It Exists
- Anthropic got blacklisted by the US government (March 2026). Provider lock-in is now existential risk.
- 4 frontier models shipped in 3 weeks (GPT-5.4, Claude 4.6, Gemini 3.1 Pro, Grok 4.20), each with distinct strengths.
- AWS had a cascading global outage from a fire in the UAE. Cloud fragility is real.
- Nobody should be locked to one model. But nobody has built the UX for navigating multi-model intelligently.

## Core Features
1. **Arena Mode**: Race 2-4 models on the same prompt. See responses side-by-side. Vote on winners. Build a personal ELO leaderboard by task type.
2. **Smart Router**: OpenAI-compatible API proxy that routes based on your arena data + cost/latency/capability preferences.
3. **Dashboard**: Real-time analytics — cost per model, win rates, latency, provider health.
4. **Failover**: If a provider is down, automatically route to the next best option.

## Architecture
- Node.js ES modules, Express for HTTP
- better-sqlite3 for local analytics (zero setup)
- Vanilla HTML/CSS/JS dashboard (no framework overhead)
- Provider adapters: OpenAI, Anthropic, Google Gemini, Groq

## Conventions
- ES modules only (`import`/`export`)
- No TypeScript for v1 — fast iteration
- Small modules, clear boundaries
- No comments on obvious code
- Complete implementations, no stubs

## Running
```bash
npm install
cp .env.example .env  # Add API keys
node src/index.js      # Starts on port 3080
# Dashboard: http://localhost:3080
# API: http://localhost:3080/v1/chat/completions
# Arena: http://localhost:3080/arena
```

## File Map
- `src/index.js` — Entry point, starts Express
- `src/proxy/server.js` — OpenAI-compatible API proxy
- `src/proxy/router.js` — Intelligent routing logic
- `src/proxy/providers/` — Provider adapters (openai, anthropic, google, groq)
- `src/arena/arena.js` — Arena mode: race models, collect votes
- `src/arena/scorer.js` — ELO scoring + preference learning
- `src/db/store.js` — SQLite wrapper for all data
- `src/db/schema.sql` — Database schema
- `src/health/monitor.js` — Provider health monitoring
- `src/dashboard/` — Web UI (HTML/CSS/JS)
