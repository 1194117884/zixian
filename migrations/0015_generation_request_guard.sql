CREATE TABLE generation_locks (
  owner_id TEXT PRIMARY KEY REFERENCES users(id),
  generation_job_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX generation_locks_by_created_at
  ON generation_locks(created_at);
