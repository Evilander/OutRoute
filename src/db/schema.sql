-- Prism Database Schema

-- Every request that flows through the proxy
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  strategy TEXT NOT NULL,
  prompt_preview TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  latency_ms INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  status TEXT DEFAULT 'ok',
  error_message TEXT,
  task_type TEXT DEFAULT 'general',
  routing_reason TEXT
);

-- Arena battles
CREATE TABLE IF NOT EXISTS battles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  prompt TEXT NOT NULL,
  task_type TEXT DEFAULT 'general',
  status TEXT DEFAULT 'pending',   -- pending | voted (human) | revealed (identities shown without a vote)
  origin TEXT DEFAULT 'arena'      -- arena | shadow | eval
);

-- Arena battle contestants (one row per model in a battle)
CREATE TABLE IF NOT EXISTS battle_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  battle_id INTEGER NOT NULL REFERENCES battles(id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  response TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  latency_ms INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  is_winner INTEGER DEFAULT 0,
  position INTEGER NOT NULL
);

-- Pairwise outcomes. Ratings are derived from this log, never stored.
-- A human vote on an N-way battle yields winner-vs-each-loser rows; the judge
-- yields one row per pair it actually compared.
CREATE TABLE IF NOT EXISTS comparisons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  battle_id INTEGER REFERENCES battles(id),
  model_a TEXT NOT NULL,
  model_b TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('a', 'b', 'tie')),
  task_type TEXT NOT NULL DEFAULT 'general',
  source TEXT NOT NULL CHECK (source IN ('human', 'judge')),
  judge_model TEXT,
  consistent INTEGER,              -- judge only: 1 when both presentation orders agreed
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_comparisons_battle ON comparisons(battle_id);
CREATE INDEX IF NOT EXISTS idx_comparisons_task ON comparisons(task_type);

-- Provider health status
CREATE TABLE IF NOT EXISTS provider_health (
  provider TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'unknown',
  last_check TEXT,
  last_success TEXT,
  last_failure TEXT,
  consecutive_failures INTEGER DEFAULT 0,
  avg_latency_ms REAL DEFAULT 0
);

-- Dynamic model registry (for OpenRouter and future dynamic providers)
CREATE TABLE IF NOT EXISTS model_registry (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  context_window INTEGER NOT NULL DEFAULT 4096,
  price_prompt_1k REAL,            -- NULL = price unknown
  price_completion_1k REAL,
  is_active INTEGER DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_model_registry_provider ON model_registry(provider);

-- Auto-judge evaluations
CREATE TABLE IF NOT EXISTS evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  battle_id INTEGER NOT NULL REFERENCES battles(id),
  model_a TEXT NOT NULL,
  model_b TEXT NOT NULL,
  winner_model TEXT,
  judge_model TEXT NOT NULL,
  inferred_domain TEXT,
  reasoning TEXT,
  is_auto INTEGER DEFAULT 1,
  linked_manual_id INTEGER,
  judge_consistency_score REAL,
  cost_usd REAL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_evaluations_battle ON evaluations(battle_id);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp);
CREATE INDEX IF NOT EXISTS idx_requests_provider ON requests(provider);
CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(model);
CREATE INDEX IF NOT EXISTS idx_battles_timestamp ON battles(timestamp);
CREATE INDEX IF NOT EXISTS idx_battle_entries_battle ON battle_entries(battle_id);
