CREATE TABLE IF NOT EXISTS posts (
  uri TEXT PRIMARY KEY,
  cid TEXT NOT NULL,
  author_handle TEXT NOT NULL,
  author_did TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  reply_count INTEGER DEFAULT 0,
  repost_count INTEGER DEFAULT 0,
  like_count INTEGER DEFAULT 0,
  quote_count INTEGER DEFAULT 0,
  raw_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at);

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at TEXT NOT NULL DEFAULT (datetime('now')),
  posts_fetched INTEGER NOT NULL,
  posts_inserted INTEGER NOT NULL,
  posts_updated INTEGER NOT NULL,
  status TEXT NOT NULL,
  error_message TEXT
);