-- =====================================================
-- Customize Tool — "Gửi chen": what reaches @flexiprint while it is working on a bộ nhân vật
--
-- One row per thing the agent has not read yet (server/agent/inbox.ts):
--   kind 'message'  the editor's "Gửi chen" (text + pictures) — POST ai/agent-tasks/:id/inject
--   kind 'edit'     a change made by hand in the editor while a task runs (a clipart fixed, the brief edited…) —
--                   written by the char/* routes
-- The next MCP tool call of a task of that bộ gets the unread rows at the end of its answer (server/mcp/server.ts)
-- and marks them seen; submit_result is refused while a message is unread.
--
-- Rows are written and read by the server only (service role). Additive; run after 001–027. Re-runnable.
-- =====================================================

SET search_path TO flexiprint, public;

CREATE TABLE IF NOT EXISTS flexiprint.ct_agent_inbox (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID NOT NULL,
  task_id      UUID REFERENCES flexiprint.ct_agent_tasks(id) ON DELETE SET NULL,
  user_id      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('message', 'edit')),
  text         TEXT NOT NULL DEFAULT '',
  attachments  JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  seen_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ct_agent_inbox_unread ON flexiprint.ct_agent_inbox(project_id, created_at) WHERE seen_at IS NULL;

ALTER TABLE flexiprint.ct_agent_inbox ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON flexiprint.ct_agent_inbox TO service_role;
