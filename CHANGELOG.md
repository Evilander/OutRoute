# Changelog

## 0.2.0

Prism 0.1 kept an online Elo number per model and routed on it. This release replaces that with a comparison log and ratings fitted from it, and fixes a long list of bugs found while doing so. Existing databases are migrated on first start; the comparison log is rebuilt from your battle history.

### Ratings

- Ratings are a Bradley-Terry fit over every recorded comparison, with 95% intervals from a parametric bootstrap and a per-model probability of being the best. They no longer depend on the order battles happened in. A model that has won every game it played gets a wide interval, not a zero-width one.
- Ties can be recorded, by you or by the judge, and count as half a win each.
- A model needs 5 games before the router will act on its rating.
- Fixed: the judge filed its results under `coding` and `analytical` while the router looked them up under `code` and `analysis`, so judged battles never influenced routing. There is now one task taxonomy.
- Fixed: task detection matched substrings, so "capital" counted as an `api` question.

### Routing

- New `value` strategy: the cheapest model that the data cannot show to be worse than the leader.
- `best` no longer falls back to "whichever provider was listed first" when nothing is rated; it says so in the routing reason.
- Failover tries at most two other models and moves to a different provider before trying the same one again. Providers with three consecutive failures go to the back of the queue. It used to walk every model of a dead provider first.
- A request that names a model no longer fails over to a different one. You get that model's error.
- `model: "auto"` means "you choose", since OpenAI SDKs will not send a request without a model.
- The router chooses among a short curated list per provider plus models you have compared, not everything the provider's catalog lists. Any model can still be named.
- Streaming requests now fail over if the provider errors before the first token.
- Fixed: every streamed response was sent twice, because the provider's final chunk carried the full text and was forwarded as another delta.
- Fixed: streamed requests were logged with zero output tokens and zero cost.
- Fixed: `temperature: 0` was replaced with `0.7`.
- Fixed: `tools`, `stop`, `top_p`, `seed`, `response_format` and the penalties were dropped without notice. They are forwarded now, requests with `tools` go only to providers that support them, and anything ignored is listed in `prism.ignored_params`.
- `finish_reason` is carried through from the provider. It used to always say `stop`.
- When the last provider tried answers with a 4xx (a retired model, a bad request, a rate limit), that status reaches the caller. It used to be a blanket 502.

### Judge

- The judge no longer closes a battle. Before, it marked the battle as voted within a second or two, which locked you out of voting on it.
- Disagreement between the two position-swapped verdicts is recorded as a tie. It used to count as a win for the model listed first.
- The judge is picked from a provider that has no model in the comparison. If that provider is not answering, the next candidate rules, and the failing provider sits out for ten minutes.
- Two tie verdicts across the position swap count as consistent. Only a verdict that changes with the order counts against the judge.
- Only pairs the judge actually compared are recorded.
- The judge sees the whole prompt. It used to see the first 500 characters.
- Contestant text can no longer break out of its tag in the judge prompt.
- Judge agreement with your own votes (raw and Cohen's kappa), position consistency, and how often it picks the longer response are reported at `/arena/judge` and in the dashboard.

### Shadow evaluation

- New, off by default: replay a fraction of proxy requests to a second model and let the judge compare them, with a daily spend cap.

### Providers

- Model lists are read from each provider's API at startup. The hardcoded lists had gone stale.
- Prices come from OpenRouter's public catalog. An unmatched price is "unknown", never zero.
- New adapters: xAI, Mistral, Ollama.
- A built-in mock provider runs Prism with no API keys (`npm run demo`) and backs the test suite.
- OpenAI reasoning models get `max_completion_tokens`, and a parameter the model rejects is dropped and the call retried once.
- Anthropic and Gemini: fixed crashes on messages without `content`, consecutive same-role turns, a leading assistant turn, and image parts. Blocked Gemini responses are reported as errors, not as empty successes.
- Fixed: the Anthropic health check sent a billed completion every 60 seconds. Health checks now use the models endpoint.
- Provider timeouts cover the whole response, not just the headers.

### Arena

- Blind responses no longer include cost or token counts; price alone identified most models.
- Votes and the judge's verdict are separate records, and your vote wins when both exist.
- A streaming session cannot be finalized before its models finish, and finalizing twice no longer duplicates entries.
- A model listed twice in one battle is compared once.

### Dashboard

- Rewritten. Ratings are drawn with their intervals, there is a cost-against-quality chart, a judge reliability page, and a plain-language summary of what the data does and does not show.
- Fixed: the server's Content-Security-Policy blocked the old dashboard's inline styles and web fonts, so it never rendered as designed. The new one uses neither.
- Fixed: setting `PRISM_SECRET` broke the dashboard, which never sent the token.
- Light and dark themes, usable on a phone.

### Security

- Rate limits are keyed on the caller's address. They were keyed on the `Authorization` header, so sending a different header with each request turned them off.
- Twenty wrong bearer tokens from one address lock it out for a minute.
- `CORS_ORIGIN=*` is refused.
- No CORS headers unless `CORS_ORIGIN` is set. The wildcard let any web page you visited send requests through your local Prism.
- Requests with a non-loopback `Host` header are rejected when listening on localhost (DNS rebinding).
- Token comparison no longer leaks the secret's length or throws on multi-byte secrets.
- Docker Compose publishes the port on `127.0.0.1` only, and the container port no longer moves when `PORT` is set in `.env`.

### Other

- `prism` command line: `demo`, `eval`, `leaderboard`, `route`, `export`.
- `HOST=localhost` binds `127.0.0.1`, so both spellings reach the server. On Windows it used to bind `::1` only, and `http://127.0.0.1:3080` was refused.
- Starting a comparison is rate-limited; voting and revealing no longer share that limit.
- The test suite runs offline and no longer writes to your real database.
- Schema migrations are versioned with `PRAGMA user_version`.
