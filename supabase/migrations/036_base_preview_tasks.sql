-- 036: agent task kind 'base_preview' (2026-11-17) — a product base whose store preview hides part of the artwork is
-- sent to @flexiprint: it measures the preview, draws new preview photos (MCP make_base_scene) and recommends one.
-- input.basePreview = {baseId, baseName, request}; result = {summary, sceneId, applied}.

ALTER TABLE flexiprint.ct_agent_tasks DROP CONSTRAINT IF EXISTS ct_agent_tasks_kind_check;
ALTER TABLE flexiprint.ct_agent_tasks ADD CONSTRAINT ct_agent_tasks_kind_check CHECK (kind IN ('create', 'revise', 'pack_image', 'content', 'char', 'mockup', 'base_preview'));
CREATE INDEX IF NOT EXISTS idx_ct_agent_tasks_base_preview ON flexiprint.ct_agent_tasks ((input->'basePreview'->>'baseId'), created_at DESC) WHERE kind = 'base_preview';
