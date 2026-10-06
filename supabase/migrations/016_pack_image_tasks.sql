-- =====================================================
-- Customize Tool — "Tạo ảnh với AI" of the thư viện ảnh tổ hợp goes to @flexiprint
--
-- ct_agent_tasks kind 'pack_image': input.pack = {description, refUrls, aspect, baseId, baseUrl} (baseId = a
-- library photo to keep editing); the agent reads the request, looks in the library first, makes the photos with
-- MCP generate_pack_image (prompt it writes, references, a transparent cut-out for layers), looks at them, fixes,
-- and submits result {summary, imageIds}.
--
-- ct_pack_images:
--   task_id    the agent task that made it (null: uploaded, or made directly from an edited prompt)
--   parent_id  the photo it was edited from ("Chỉnh tiếp" / "Tạo lại với prompt này")
--   transparent  background cut out (a layer: fingers, a hand, a prop)
--   listed     shown in the library — the agent's drafts are not, until it submits them
--
-- Additive; run after 001–015.
-- =====================================================

SET search_path TO flexiprint, public;

ALTER TABLE flexiprint.ct_agent_tasks DROP CONSTRAINT IF EXISTS ct_agent_tasks_kind_check;
ALTER TABLE flexiprint.ct_agent_tasks ADD CONSTRAINT ct_agent_tasks_kind_check CHECK (kind IN ('create', 'revise', 'pack_image'));

ALTER TABLE flexiprint.ct_pack_images ADD COLUMN IF NOT EXISTS task_id UUID REFERENCES flexiprint.ct_agent_tasks(id) ON DELETE SET NULL;
ALTER TABLE flexiprint.ct_pack_images ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES flexiprint.ct_pack_images(id) ON DELETE SET NULL;
ALTER TABLE flexiprint.ct_pack_images ADD COLUMN IF NOT EXISTS transparent BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE flexiprint.ct_pack_images ADD COLUMN IF NOT EXISTS listed BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_ct_pack_images_task ON flexiprint.ct_pack_images(task_id);

-- The agent (service role) saves its photos and removes the drafts it did not keep.
GRANT DELETE ON flexiprint.ct_pack_images TO service_role;

NOTIFY pgrst, 'reload schema';
