# flexiprint — MCP tổng của FlexiPrint (chạy trên máy người dùng)

Một MCP cho mọi việc: import folder bộ, ảnh từ máy lên, lưu file về máy (tool `flexiprint_*`, chạy trên máy), cùng
mọi tool của flexiprint-mcp trên server flexi2 (thư viện, artwork, sản phẩm, mockup, deploy Shopify, bộ nhân vật),
gọi bằng tài khoản flexi2 của người dùng. Thay `integrations/flexiprint-import` (từ 2026-11-17).

- Cài: [HUONG-DAN-CAI-DAT.md](HUONG-DAN-CAI-DAT.md) (đưa file này cho Claude Code). File tải về:
  `https://flexi2.next.lc/flexiprint-mcp.mjs` (Dockerfile chép `server.mjs` vào `public/` khi build).
- Thử không cần Claude Code: `node server.mjs tools` · `node server.mjs call list_base_products '{}'` ·
  `node server.mjs import <folder>` · `node server.mjs status <set_id>`.
- Quyền (server/mcp/server.ts, task-common.ts): sản phẩm / bộ / task của chính người dùng, admin thì tất cả.
  Tool sản phẩm và deploy bỏ `task_id`; bộ nhân vật đi qua task riêng (`char_create_set` / `char_open_task`).
