# CLAUDE.md — Prism

## What This Is
An intelligent LLM arena + router. Race frontier models against each other, build a personal preference profile, then auto-route in production.

## Why It Exists
- Anthropic got blacklisted by the US government (March 2026). Provider lock-in is now existential risk.
- 4 frontier models shipped in 3 weeks (GPT-5.4, Claude 4.6, Gemini 3.1 Pro, Grok 4.20), each with distinct strengths.
- AWS had a cascading global outage from a fire in the UAE. Cloud fragility is real.
- Nobody should be locked to one model. But nobody has built the UX for navigating multi-model intelligently.

## Core Features
1. **Arena Mode**: Race 2-8 models blind. Vote on winners. Auto-judge handles evaluation automatically.
2. **Streaming Arena**: SSE-based real-time streaming with ephemeral session proxying (opaque UUIDs for blind eval).
3. **Auto-Judge**: LLM-as-judge with domain-conditional rubric + double-blind swap for bias mitigation.
4. **Smart Router**: OpenAI-compatible API proxy with 5 routing strategies (best/cheapest/fastest/round-robin/specific).
5. **100+ Models**: OpenAI, Anthropic, Google, Groq + OpenRouter (dynamic model sync every 12h).
6. **Dashboard**: Real-time analytics — cost per model, win rates, latency, provider health.

## Architecture
- Node.js ES modules, Express 5 + Helmet for HTTP
- better-sqlite3 WAL mode for local analytics
- Dynamic model registry (SQLite table synced from OpenRouter API)
- Vanilla HTML/CSS/JS dashboard (no framework overhead)
- Provider adapters: OpenAI, Anthropic, Google Gemini, Groq, OpenRouter
- Background services: model sync, auto-judge, health monitor

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
# Or: docker compose up -d
```

## File Map
- `src/index.js` — Entry point, Express + middleware + lifecycle
- `src/proxy/server.js` — OpenAI-compatible API proxy + stats endpoints
- `src/proxy/router.js` — Intelligent routing logic (strategy, failover, cost)
- `src/proxy/providers/` — Provider adapters (openai, anthropic, google, groq, openrouter)
- `src/arena/arena.js` — Arena mode: race models, collect votes
- `src/arena/streaming.js` — Streaming arena: ephemeral sessions, SSE per-combatant
- `src/arena/scorer.js` — ELO scoring + preference learning
- `src/arena/routes.js` — Arena API endpoints (battle, vote, reveal, streaming)
- `src/services/auto-judge.js` — LLM-as-judge with double-blind evaluation
- `src/services/model-sync.js` — OpenRouter model sync (12h background job)
- `src/db/store.js` — SQLite wrapper for all data
- `src/db/schema.sql` — Database schema (requests, battles, ELO, model_registry, evaluations)
- `src/health/monitor.js` — Provider health monitoring
- `src/dashboard/` — Web UI (HTML/CSS/JS)
