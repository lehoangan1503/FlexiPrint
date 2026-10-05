-- =====================================================
-- Customize Tool — studio runs of an agent task
--
-- The agent's test images (run_studio with task_id) are recorded on its task:
--   runs  [{run_id, recipe, label, status, started_at, finished_at, asset_ids, error}]
-- so submit_result can refuse while one is still queued / running (the agent
-- must wait_run and look at them first), and the dialog can show them.
--
-- Additive; run after 001–012.
-- =====================================================

SET search_path TO flexiprint, public;

ALTER TABLE flexiprint.ct_agent_tasks ADD COLUMN IF NOT EXISTS runs JSONB NOT NULL DEFAULT '[]'::jsonb;
