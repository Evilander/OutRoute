# Prism

**Intelligent LLM arena + router.** Race frontier models head-to-head, build a personal ELO leaderboard, then auto-route production requests based on your preference data.

```
  ██████╗ ██████╗ ██╗███████╗███╗   ███╗
  ██╔══██╗██╔══██╗██║██╔════╝████╗ ████║
  ██████╔╝██████╔╝██║███████╗██╔████╔██║
  ██╔═══╝ ██╔══██╗██║╚════██║██║╚██╔╝██║
  ██║     ██║  ██║██║███████║██║ ╚═╝ ██║
  ╚═╝     ╚═╝  ╚═╝╚═╝╚══════╝╚═╝     ╚═╝
```

## Why

- Provider lock-in is existential risk. You shouldn't depend on a single model.
- 4+ frontier models ship every few weeks, each with different strengths.
- Nobody has built the UX for navigating multi-model intelligently — until now.

Prism lets you **discover** which model works best for your tasks through blind arena battles, then **automatically routes** your API calls based on that data.

## Features

- **Arena Mode** — Race 2-8 models on the same prompt. Blind evaluation. Vote on winners. Build a personal ELO leaderboard by task type (code, creative, analysis, general).
- **Streaming Arena** — Stream battle responses in real-time via SSE with ephemeral session proxying to preserve blind evaluation.
- **Auto-Judge** — LLM-as-judge with domain-conditional rubric and double-blind swap for bias mitigation. Evaluates battles automatically.
- **OpenAI-Compatible Proxy** — Drop-in replacement at `/v1/chat/completions`. Point any OpenAI SDK at Prism and it just works.
- **5 Providers, 100+ Models** — OpenAI, Anthropic, Google Gemini, Groq, and OpenRouter (with dynamic model sync).
- **5 Routing Strategies** — `best` (ELO-based), `cheapest`, `fastest`, `round-robin`, or `specific` model.
- **Automatic Failover** — If a provider goes down, requests route to the next best option.
- **Cost Tracking** — Per-request cost calculated from actual token usage and model pricing.
- **Provider Health Monitoring** — 60-second health checks with automatic degraded-provider avoidance.
- **Dashboard** — Dark-themed web UI with stats, arena battles, ELO leaderboard, and request log.
- **Docker Support** — One-command deployment via `docker compose up`.
- **Zero Dependencies Frontend** — Vanilla HTML/CSS/JS dashboard. No framework overhead.

## Supported Providers

| Provider | Models | Auth |
|----------|--------|------|
| **OpenAI** | gpt-4o, gpt-4o-mini, gpt-4-turbo, o1 | `OPENAI_API_KEY` |
| **Anthropic** | claude-opus-4, claude-sonnet-4, claude-haiku-4.5 | `ANTHROPIC_API_KEY` |
| **Google Gemini** | gemini-2.5-flash, gemini-2.5-pro, gemini-1.5-flash | `GOOGLE_API_KEY` |
| **Groq** | llama-3.3-70b, llama-3.1-8b, mixtral-8x7b | `GROQ_API_KEY` |
| **OpenRouter** | 100+ models (dynamic sync) | `OPENROUTER_API_KEY` |

Only providers with configured API keys are loaded. You can run with just one.

OpenRouter models are synced automatically every 12 hours from the OpenRouter API. Adding an OpenRouter key gives you instant access to models from Meta, Mistral, Cohere, and many more.

## Quick Start

```bash
git clone https://github.com/Evilander/prism.git
cd prism
npm install
cp .env.example .env
# Edit .env — add at least one API key
node src/index.js
```

Open http://localhost:3080 for the dashboard.

### Docker

```bash
cp .env.example .env
# Edit .env — add API keys
docker compose up -d
```

Data persists in a Docker volume (`prism-data`).

## Usage

### As an OpenAI-compatible proxy

Point any OpenAI SDK at `http://localhost:3080/v1`:

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3080/v1",
    api_key="any-string"  # or your PRISM_SECRET if auth is enabled
)

# Specific model
response = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Hello!"}]
)

# Auto-route (uses "best" strategy — picks highest ELO model for the task type)
# Omit the model field entirely — Prism selects based on your ELO data
response = client.chat.completions.create(
    messages=[{"role": "user", "content": "Write a Python merge sort"}]
)
```

The response includes a `prism` metadata block with provider, strategy, latency, cost, and failover info.

### Arena battles

```bash
# Start a blind battle
curl -X POST http://localhost:3080/arena/battle \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Explain quantum entanglement in simple terms",
    "models": ["gpt-4o-mini", "claude-haiku-4-5-20251001"]
  }'

# Vote on position 2 as winner
curl -X POST http://localhost:3080/arena/vote \
  -H "Content-Type: application/json" \
  -d '{"battleId": 1, "winnerPosition": 2}'

# Reveal which model was which (only works after voting)
curl http://localhost:3080/arena/reveal/1

# Check the leaderboard
curl http://localhost:3080/arena/leaderboard
```

### Streaming arena (SSE)

```bash
# Initialize a streaming session (returns opaque combatant UUIDs for blind eval)
curl -X POST http://localhost:3080/arena/session \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Explain monads", "models": ["gpt-4o-mini", "claude-haiku-4-5-20251001"]}'
# Returns: { sessionId, combatants: [{ id, position }] }

# Stream each combatant's response (EventSource / SSE)
curl http://localhost:3080/arena/stream/{sessionId}/{combatantId}

# Finalize session (stores entries, triggers auto-judge)
curl -X POST http://localhost:3080/arena/session/{sessionId}/finalize
```

### Auto-judge

When at least one LLM provider is available, Prism automatically evaluates arena battles using a domain-conditional rubric with double-blind swap to mitigate positional bias. Auto-judged results update ELO ratings without manual voting. Set `"autoJudge": false` in the battle request to disable.

### Routing strategies

Pass `strategy` in the request body to control model selection:

| Strategy | Behavior |
|----------|----------|
| `best` | Highest ELO rating for the detected task type (default) |
| `cheapest` | Lowest cost per 1K tokens |
| `fastest` | Lowest average latency from historical data |
| `round-robin` | Rotate through all available models |
| `specific` | Used automatically when you specify a model name |

## Configuration

```env
# Provider API keys (add at least one)
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=AI...
GROQ_API_KEY=gsk_...

# Server
PORT=3080
HOST=localhost

# Default routing strategy
DEFAULT_STRATEGY=best

# Optional: require Bearer token auth on API endpoints
# PRISM_SECRET=your-secret-here
```

When `PRISM_SECRET` is set, all API endpoints require `Authorization: Bearer <secret>`. The dashboard and health endpoint remain accessible without auth.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | POST | OpenAI-compatible chat proxy |
| `/v1/models` | GET | List available models |
| `/arena/battle` | POST | Start a blind arena battle |
| `/arena/vote` | POST | Vote on a battle winner |
| `/arena/reveal/:id` | GET | Reveal model identities (after voting) |
| `/arena/leaderboard` | GET | ELO rankings (optional `?taskType=` filter) |
| `/arena/session` | POST | Start a streaming arena session |
| `/arena/stream/:session/:combatant` | GET | SSE stream for a combatant |
| `/arena/session/:id/finalize` | POST | Finalize streaming session |
| `/arena/battles` | GET | Recent battle history |
| `/api/stats` | GET | Request statistics |
| `/api/stats/timeline` | GET | Cost timeline by hour |
| `/api/requests` | GET | Recent request log |
| `/api/providers` | GET | Provider list with health status |
| `/api/models` | GET | All models with pricing info |
| `/health` | GET | Server health check |

## Architecture

```
src/
├── index.js                  Entry point, Express setup, auth, shutdown
├── proxy/
│   ├── server.js             API proxy + stats endpoints
│   ├── router.js             Routing logic (strategy, failover, cost)
│   └── providers/
│       ├── base.js           Abstract provider interface
│       ├── openai.js          OpenAI adapter
│       ├── anthropic.js       Anthropic adapter
│       ├── google.js          Google Gemini adapter
│       ├── groq.js            Groq adapter (extends OpenAI)
│       ├── openrouter.js      OpenRouter adapter (100+ dynamic models)
│       └── index.js           Provider factory
├── arena/
│   ├── arena.js              Battle execution (parallel racing)
│   ├── streaming.js          Streaming arena (ephemeral sessions, SSE)
│   ├── scorer.js             ELO calculation
│   └── routes.js             Arena API endpoints
├── services/
│   ├── model-sync.js         OpenRouter model sync (12h background job)
│   └── auto-judge.js         LLM-as-judge with double-blind evaluation
├── dashboard/
│   ├── index.html            Web UI
│   ├── style.css             Dark theme
│   └── app.js                Dashboard logic (safe DOM, no innerHTML)
├── db/
│   ├── schema.sql            SQLite schema
│   └── store.js              Database operations
└── health/
    └── monitor.js            Provider health checking
```

## Stack

- **Runtime:** Node.js (ES modules)
- **Server:** Express 5
- **Database:** SQLite via better-sqlite3 (zero config, WAL mode)
- **Frontend:** Vanilla HTML/CSS/JS (no build step)
- **Dependencies:** 4 (express, better-sqlite3, dotenv, helmet)

## Security

- Optional bearer token auth via `PRISM_SECRET`
- Rate limiting: 60 requests/min per IP on proxy endpoint
- Input validation: temperature clamped 0-2, max_tokens capped at 16384
- Parameterized SQL queries throughout (no injection risk)
- Safe DOM manipulation in dashboard (no innerHTML with user content)
- API keys stored in private class fields, never serialized to responses
- Graceful shutdown on SIGINT/SIGTERM

## License

MIT
