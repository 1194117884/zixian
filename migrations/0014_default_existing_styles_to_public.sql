UPDATE style_templates
SET moderation_status = 'approved'
WHERE moderation_status = 'pending';
