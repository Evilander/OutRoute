# Prism Roadmap

## v0.2 — Polish & Reliability

- [ ] **Docker support** — `docker-compose.yml` for one-command deployment
- [ ] **Streaming in arena** — Stream battle responses as they arrive instead of waiting for all to complete
- [ ] **Configurable DB path** — `DB_PATH` env var instead of hardcoded project root
- [ ] **Error message sanitization** — Don't leak raw provider error details to clients
- [ ] **Message validation** — Validate message shape (role, content type) before dispatching to providers
- [ ] **Security headers** — Add helmet or equivalent (CSP, X-Frame-Options, etc.)
- [ ] **N+1 query fix** — Replace per-battle entry queries with a single JOIN in `getRecentBattles`
- [ ] **Dashboard visibility API** — Stop polling when tab is backgrounded

## v0.3 — More Providers & Smarts

- [ ] **Mistral provider** — Add Mistral AI adapter
- [ ] **Ollama provider** — Local model support via Ollama API
- [ ] **OpenRouter provider** — Access 100+ models through OpenRouter
- [ ] **Dynamic model discovery** — Fetch available models from provider APIs instead of hardcoded lists
- [ ] **Dynamic pricing** — Pull current pricing from provider APIs or a config file
- [ ] **Task-type ELO routing** — Route code prompts to the model with highest code ELO, creative to creative ELO, etc. (partially implemented)
- [ ] **Cost budgeting** — Set daily/monthly cost limits per provider or globally
- [ ] **Weighted multi-criteria routing** — Combine ELO, cost, and latency with configurable weights

## v0.4 — Arena Enhancements

- [ ] **Auto-judge** — Optional LLM-as-judge for automated scoring (skip manual voting)
- [ ] **Multi-round battles** — Conversation battles (not just single-turn)
- [ ] **Battle categories** — Pre-defined battle templates (code review, creative writing, summarization, etc.)
- [ ] **Battle history export** — Export results as JSON/CSV for analysis
- [ ] **ELO confidence intervals** — Show uncertainty in ratings for models with few battles
- [ ] **Head-to-head stats** — Win rates for specific model pairs
- [ ] **Tie votes** — Allow "both equally good" as a vote option

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

- **Preference learning** — Train a lightweight model on your voting patterns to predict preferences
- **A/B testing mode** — Route a percentage of traffic through arena battles for continuous evaluation
- **Response caching** — Cache identical prompts to reduce cost (with TTL and invalidation)
- **Prompt optimization** — Suggest prompt modifications based on which phrasings get better results per model
- **Plugin system** — Custom routing strategies and provider adapters as plugins
