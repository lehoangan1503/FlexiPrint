-- =====================================================
-- Customize Tool — the agent asks the editor mid-task
--
-- ask_user (server/mcp/tools.ts) puts a question on the task and the agent ends its turn:
--   status    'waiting' while the question is open
--   questions [{id, question, options: [{label, description}], multi, allow_text, asked_at,
--               answer: {choices, text, at} | null}]
-- The dialog shows it; POST ai/agent-tasks/:id/answer records the answer and sends it to the agent
-- as a new turn in the same agent_ide session (server/agent/tasks.ts).
--
-- Additive; run after 001–013.
-- =====================================================

SET search_path TO flexiprint, public;

ALTER TABLE flexiprint.ct_agent_tasks ADD COLUMN IF NOT EXISTS questions JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE flexiprint.ct_agent_tasks DROP CONSTRAINT IF EXISTS ct_agent_tasks_status_check;
ALTER TABLE flexiprint.ct_agent_tasks ADD CONSTRAINT ct_agent_tasks_status_check
  CHECK (status IN ('pending', 'running', 'waiting', 'done', 'failed', 'cancelled'));
