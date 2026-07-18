CREATE TABLE IF NOT EXISTS style_templates (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  source_document_id TEXT NOT NULL REFERENCES documents(id),
  source_version_id TEXT NOT NULL REFERENCES document_versions(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  style_key TEXT NOT NULL,
  likes_count INTEGER NOT NULL DEFAULT 0,
  uses_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source_document_id, source_version_id)
);

CREATE INDEX IF NOT EXISTS style_templates_by_popularity
  ON style_templates(uses_count DESC, likes_count DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS style_template_likes (
  template_id TEXT NOT NULL REFERENCES style_templates(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(template_id, user_id)
);

CREATE TABLE IF NOT EXISTS style_template_uses (
  template_id TEXT NOT NULL REFERENCES style_templates(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(template_id, user_id)
);
