ALTER TABLE generation_jobs ADD COLUMN provider_platform TEXT;
ALTER TABLE generation_jobs ADD COLUMN provider_model_name TEXT;
ALTER TABLE generation_jobs ADD COLUMN provider_account_id TEXT;
ALTER TABLE generation_jobs ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE generation_jobs ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE generation_jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE generation_attempts (
  id TEXT PRIMARY KEY,
  generation_job_id TEXT NOT NULL REFERENCES generation_jobs(id),
  attempt_index INTEGER NOT NULL,
  provider_platform TEXT NOT NULL,
  provider_model_name TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  http_status INTEGER,
  error_code TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX generation_attempts_by_job_created_at
  ON generation_attempts(generation_job_id, created_at DESC);
