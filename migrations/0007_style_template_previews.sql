ALTER TABLE style_templates ADD COLUMN aspect_ratio TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE style_templates ADD COLUMN preview_object_key TEXT;
