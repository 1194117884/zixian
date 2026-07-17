CREATE TABLE IF NOT EXISTS published_pages (
  slug TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  version_id TEXT NOT NULL REFERENCES document_versions(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS published_pages_by_document
  ON published_pages(document_id, created_at DESC);
