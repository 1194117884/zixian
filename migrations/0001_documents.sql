CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'archived')) DEFAULT 'draft',
  current_version_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS documents_by_owner_updated_at
  ON documents(owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS document_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  parent_version_id TEXT REFERENCES document_versions(id),
  style_source_version_id TEXT REFERENCES document_versions(id),
  content_json TEXT NOT NULL,
  html_object_key TEXT NOT NULL,
  safety_status TEXT NOT NULL CHECK (safety_status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS versions_by_document_created_at
  ON document_versions(document_id, created_at DESC);
