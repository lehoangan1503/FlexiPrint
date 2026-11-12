-- 035: agent task kind 'mockup' (2026-11-12) — a mockup photo the image model refused on safety grounds is sent to
-- @flexiprint: it rewrites the job's prompt and draws the same job again (MCP retry_mockup).
-- input.mockup = {productId, productName, jobId, scene, prompt, error, refUrl, request}; result = {summary, prompt, jobId}.

ALTER TABLE flexiprint.ct_agent_tasks DROP CONSTRAINT IF EXISTS ct_agent_tasks_kind_check;
ALTER TABLE flexiprint.ct_agent_tasks ADD CONSTRAINT ct_agent_tasks_kind_check CHECK (kind IN ('create', 'revise', 'pack_image', 'content', 'char', 'mockup'));
CREATE INDEX IF NOT EXISTS idx_ct_agent_tasks_mockup_product ON flexiprint.ct_agent_tasks ((input->'mockup'->>'productId'), created_at DESC) WHERE kind = 'mockup';
