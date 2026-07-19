ALTER TABLE style_templates ADD COLUMN moderation_status TEXT NOT NULL DEFAULT 'approved' CHECK (moderation_status IN ('pending', 'approved', 'hidden'));

CREATE INDEX style_templates_by_moderation_created_at
  ON style_templates(moderation_status, created_at DESC);
