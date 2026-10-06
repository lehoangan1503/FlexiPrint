-- =====================================================
-- Customize Tool — "Tạo content với FlexiPrint" (Deploy page)
--
-- ct_agent_tasks kind 'content': input.content = {productId, productName, request, title, descriptionHtml, facts,
-- imageUrls}; result = {summary, title, descriptionHtml}. A product's content tasks are one conversation with
-- @flexiprint (history on the Deploy page, "sửa tiếp" continues the agent_ide session).
--
-- Additive; run after 001–018.
-- =====================================================

SET search_path TO flexiprint, public;

ALTER TABLE flexiprint.ct_agent_tasks DROP CONSTRAINT IF EXISTS ct_agent_tasks_kind_check;
ALTER TABLE flexiprint.ct_agent_tasks ADD CONSTRAINT ct_agent_tasks_kind_check CHECK (kind IN ('create', 'revise', 'pack_image', 'content'));
CREATE INDEX IF NOT EXISTS idx_ct_agent_tasks_content_product ON flexiprint.ct_agent_tasks ((input->'content'->>'productId'), created_at DESC) WHERE kind = 'content';

NOTIFY pgrst, 'reload schema';
