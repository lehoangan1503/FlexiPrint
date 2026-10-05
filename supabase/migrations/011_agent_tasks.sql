-- =====================================================
-- Customize Tool — agent tasks (the editor's own agent instead of the built-in LLM)
--
-- The category dialog can hand its AI work (Tạo bằng AI, Cập nhật bằng AI,
-- Kiểm tra prompt) to the @flexiprint agent on agent_ide instead of Gemini
-- Flash. One row per hand-off (server/agent/tasks.ts):
--
--   browser  → POST ai/agent-tasks       row 'pending', sent to agent_ide
--                                         (/kernel/v1/turns) → 'running'
--   agent    → MCP get_task / report_progress / submit_result | fail_task
--                                         (server/mcp — service client)
--   browser  ← GET ai/agent-tasks/:id     progress, then the result in the
--                                         same shape the built-in LLM returns
--
--   kind     'create' (CtPromptSuggestion) | 'revise' (CtCategoryRevision; an
--            empty note = review only)
--   input    what the dialog would have sent the built-in LLM (urls only)
--   result   the converted plan; the editor still ticks and applies it
--   agent_*  agent_ide's job / session ids; one session per category keeps
--            the agent's memory of that category between tasks
--
-- Additive; run after 001–010.
-- =====================================================

SET search_path TO flexiprint, public;

CREATE TABLE IF NOT EXISTS flexiprint.ct_agent_tasks (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  category_id       UUID REFERENCES flexiprint.ct_clipart_categories(id) ON DELETE SET NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('create', 'revise')),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed', 'cancelled')),
  input             JSONB NOT NULL DEFAULT '{}'::jsonb,
  progress          JSONB NOT NULL DEFAULT '[]'::jsonb,
  result            JSONB,
  error             TEXT NOT NULL DEFAULT '',
  agent_job_id      TEXT NOT NULL DEFAULT '',
  agent_session_id  TEXT NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ct_agent_tasks_user ON flexiprint.ct_agent_tasks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ct_agent_tasks_category ON flexiprint.ct_agent_tasks(category_id, created_at DESC);

DROP TRIGGER IF EXISTS ct_agent_tasks_touch ON flexiprint.ct_agent_tasks;
CREATE TRIGGER ct_agent_tasks_touch BEFORE UPDATE ON flexiprint.ct_agent_tasks
  FOR EACH ROW EXECUTE FUNCTION flexiprint.ct_touch_updated_at();

ALTER TABLE flexiprint.ct_agent_tasks ENABLE ROW LEVEL SECURITY;

-- The editor sees and cancels their own tasks; everything else is written by the server (service role).
DROP POLICY IF EXISTS "ct_agent_tasks_own" ON flexiprint.ct_agent_tasks;
CREATE POLICY "ct_agent_tasks_own" ON flexiprint.ct_agent_tasks
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE ON flexiprint.ct_agent_tasks TO authenticated;
GRANT SELECT, INSERT, UPDATE ON flexiprint.ct_agent_tasks TO service_role;

-- The agent reads the whole library through the MCP (service role): history too.
GRANT SELECT ON flexiprint.ct_category_history, flexiprint.ct_preset_history TO service_role;
