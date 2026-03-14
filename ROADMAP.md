# Prism Roadmap

## v0.2 — Scale & Automation (current)

- [x] **Docker support** — `docker-compose.yml` + multi-stage Dockerfile
- [x] **Streaming in arena** — Ephemeral session proxying with opaque UUID combatants, per-model SSE streams
- [x] **Configurable DB path** — `DB_PATH` env var instead of hardcoded project root
- [x] **Error message sanitization** — Don't leak raw provider error details to clients
- [x] **Message validation** — Validate message shape (role, content type) before dispatching to providers
- [x] **Security headers** — Helmet middleware (CSP, X-Frame-Options, etc.)
- [x] **N+1 query fix** — Replaced per-battle entry queries with a single JOIN in `getRecentBattles`
- [x] **OpenRouter provider** — Access 100+ models through OpenRouter with dynamic model sync
- [x] **Dynamic model registry** — SQLite `model_registry` table, background sync from OpenRouter API every 12h
- [x] **Auto-judge** — LLM-as-judge with domain-conditional rubric, double-blind swap for bias mitigation
- [ ] **Dashboard visibility API** — Stop polling when tab is backgrounded

## v0.3 — Production Intelligence

- [ ] **Unified model registry** — Migrate direct providers (OpenAI, Anthropic, Google, Groq) into the DB model registry
- [ ] **Advanced fallback chains** — User-defined fallback sequences in request payload (e.g., `["gpt-4o", "fallback:openrouter/auto"]`)
- [ ] **ELO dashboard visualization** — Domain-sliced ratings (Model X is #1 in Coding, #4 in Creative)
- [ ] **Multi-round battles** — Conversation battles with session-state hydration for blind follow-ups
- [ ] **Cost budgeting** — Set daily/monthly cost limits per provider or globally
- [ ] **Mistral provider** — Add Mistral AI adapter
- [ ] **Ollama provider** — Local model support via Ollama API
- [ ] **Weighted multi-criteria routing** — Combine ELO, cost, and latency with configurable weights

## v0.4 — Arena Enhancements

- [ ] **Battle categories** — Pre-defined battle templates (code review, creative writing, summarization, etc.)
- [ ] **Battle history export** — Export results as JSON/CSV for analysis
- [ ] **ELO confidence intervals** — Show uncertainty in ratings for models with few battles
- [ ] **Head-to-head stats** — Win rates for specific model pairs
- [ ] **Tie votes** — Allow "both equally good" as a vote option
- [ ] **Semantic caching** — Cache identical prompts to reduce cost (prompt hash → cached response with TTL)
- [ ] **Auto-judge accuracy tracking** — Compare auto-judge vs human-judge on same battles, track failure rate

## v0.5 — Dashboard & UX

- [ ] **Cost over time chart** — Visualization of spending trends by provider/model
- [ ] **Model comparison radar** — Multi-axis comparison (cost, speed, quality by task type)
- [ ] **Battle replay** — Re-read past battles with full prompt and responses
- [ ] **Dark/light theme toggle**
- [ ] **Mobile-responsive layout**
- [ ] **Dashboard auth** — Optional login for the web dashboard
- [ ] **WebSocket live updates** — Replace polling with real-time push

## v0.6 — Integration & Deployment

- [ ] **MCP server** — Expose Prism as an MCP tool so AI agents can trigger arena battles
- [ ] **CLI tool** — `prism battle "prompt" --models gpt-4o,claude-sonnet-4` from the terminal
- [ ] **PM2 / systemd config** — Production process management
- [ ] **Prometheus metrics** — Export request/cost/latency metrics for Grafana
- [ ] **Webhook notifications** — Alert on provider outages, cost thresholds, etc.
- [ ] **Multi-user support** — Separate ELO profiles per user/API key

## Future Ideas

- **Continuous background benchmarking** — Auto-run silent battles between models when idle (requires cost budgeting)
- **Preference learning** — Train a lightweight model on your voting patterns to predict preferences
- **A/B testing mode** — Route a percentage of traffic through arena battles for continuous evaluation
- **Prompt optimization** — Suggest prompt modifications based on which phrasings get better results per model
- **Plugin system** — Custom routing strategies and provider adapters as plugins
