-- =====================================================
-- Customize Tool — v2 bộ nhân vật steps done by @flexiprint
--
-- ct_agent_tasks kind 'char': input.char = {projectId, step: brainstorm|master|edits, request, imageId, roles};
-- result = {step, summary, roundId?, imageIds?}. A project's tasks are one conversation with the agent (the next
-- task continues its agent_ide session).
--
-- Additive; run after 001–021.
-- =====================================================

SET search_path TO flexiprint, public;

ALTER TABLE flexiprint.ct_agent_tasks DROP CONSTRAINT IF EXISTS ct_agent_tasks_kind_check;
ALTER TABLE flexiprint.ct_agent_tasks ADD CONSTRAINT ct_agent_tasks_kind_check CHECK (kind IN ('create', 'revise', 'pack_image', 'content', 'char'));
CREATE INDEX IF NOT EXISTS idx_ct_agent_tasks_char_project ON flexiprint.ct_agent_tasks ((input->'char'->>'projectId'), created_at DESC) WHERE kind = 'char';

NOTIFY pgrst, 'reload schema';
