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
  status TEXT DEFAULT 'pending'
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

-- ELO ratings per model per task type
CREATE TABLE IF NOT EXISTS elo_ratings (
  model TEXT NOT NULL,
  task_type TEXT NOT NULL DEFAULT 'general',
  rating REAL NOT NULL DEFAULT 1500,
  wins INTEGER DEFAULT 0,
  losses INTEGER DEFAULT 0,
  battles INTEGER DEFAULT 0,
  last_updated TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (model, task_type)
);

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
  price_prompt_1k REAL NOT NULL DEFAULT 0,
  price_completion_1k REAL NOT NULL DEFAULT 0,
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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_evaluations_battle ON evaluations(battle_id);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp);
CREATE INDEX IF NOT EXISTS idx_requests_provider ON requests(provider);
CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(model);
CREATE INDEX IF NOT EXISTS idx_battles_timestamp ON battles(timestamp);
CREATE INDEX IF NOT EXISTS idx_battle_entries_battle ON battle_entries(battle_id);
