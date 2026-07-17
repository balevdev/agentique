CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  origin_url TEXT,
  abs_path   TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  mini_spec    TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','approved','in_progress','review','committed')),
  baseline_sha TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS items (
  id         INTEGER PRIMARY KEY,
  task_id    INTEGER NOT NULL REFERENCES tasks(id),
  ordinal    INTEGER NOT NULL,
  title      TEXT NOT NULL,
  files      TEXT NOT NULL DEFAULT '',
  done_when  TEXT NOT NULL DEFAULT '',
  contract   TEXT,
  sensitive  TEXT,
  status     TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','done')),
  journal_id INTEGER  -- soft pointer into journal; journal is append-only
);

CREATE TABLE IF NOT EXISTS knowledge_sections (
  id           INTEGER PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  kind         TEXT NOT NULL
               CHECK (kind IN ('layout','boundary','convention','sensitive_zone','gotcha')),
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  paths_glob   TEXT NOT NULL DEFAULT '',
  verified_sha TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, kind, title)
);

CREATE TABLE IF NOT EXISTS journal (
  id           INTEGER PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  task_id      INTEGER REFERENCES tasks(id),
  item_id      INTEGER REFERENCES items(id),
  entry_kind   TEXT NOT NULL CHECK (entry_kind IN ('tick','approval','stop','note')),
  gate_verdict TEXT,
  decisions    TEXT NOT NULL DEFAULT '',
  questions    TEXT NOT NULL DEFAULT '',
  patch        TEXT,
  head_sha     TEXT,
  tree_hash    TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS journal_fts USING fts5(
  decisions, questions, item_title, content=''
);

CREATE TABLE IF NOT EXISTS gate_commands (
  project_id TEXT NOT NULL REFERENCES projects(id),
  ordinal    INTEGER NOT NULL,
  command    TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (project_id, ordinal)
);

CREATE TABLE IF NOT EXISTS prefs (
  key  TEXT PRIMARY KEY,
  body TEXT NOT NULL
);
