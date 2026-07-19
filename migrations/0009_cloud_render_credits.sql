CREATE TABLE credit_ledger_next (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('purchase', 'generation', 'cloud_render', 'refund', 'adjustment')),
  generation_job_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO credit_ledger_next (id, user_id, amount, reason, generation_job_id, idempotency_key, created_at)
  SELECT id, user_id, amount, reason, generation_job_id, idempotency_key, created_at FROM credit_ledger;

DROP TABLE credit_ledger;
ALTER TABLE credit_ledger_next RENAME TO credit_ledger;

CREATE INDEX credit_ledger_by_user_created_at
  ON credit_ledger(user_id, created_at DESC);

CREATE TABLE render_jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  document_id TEXT NOT NULL REFERENCES documents(id),
  version_id TEXT NOT NULL REFERENCES document_versions(id),
  export_id TEXT REFERENCES exports(id),
  cost_credits INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'refunded')),
  idempotency_key TEXT NOT NULL UNIQUE,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE INDEX render_jobs_by_owner_created_at
  ON render_jobs(owner_id, created_at DESC);
