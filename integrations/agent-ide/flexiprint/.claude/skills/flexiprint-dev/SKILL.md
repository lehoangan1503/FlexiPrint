---
name: flexiprint-dev
description: Sửa code FlexiPrint và deploy lên VPS khi gặp lỗi / thiếu tính năng (tool MCP lỗi, sản phẩm sai do code, người dùng nhờ sửa / thêm chức năng) — như một phiên Claude Code trên repo: đọc code, sửa, typecheck + lint, commit, push, deploy, kiểm tra lại.
---

# Sửa code + deploy FlexiPrint

**Repo**: thư mục cha của project này — `../../..` (`C:\Users\b\code\flexiprint`, Git Bash: `/c/Users/b/code/flexiprint`).
Next.js (bản mới, khác kiến thức cũ — đọc `node_modules/next/dist/docs/` trước khi đụng API Next), React, Supabase,
sharp; dịch vụ Python trong `services/` (layer-kit: cắt layer).
Đọc `CLAUDE.md` / `AGENTS.md` của repo trước. Luật code: không dùng `any` (viết interface), code giống code xung quanh
(cùng kiểu chú thích, đặt tên), không thêm luật vá vào bước cắt (layer-rules §9b).

## Chỗ hay sửa
- `customize-tool/server/char/*` (bộ v2: brief, master, edits, cut, product, elements, backdrops),
  `customize-tool/server/mcp/*` (tool của bạn), `customize-tool/lib/char-*.ts`, `customize-tool/components/char/*` (trang /v2),
  `customize-tool/server/product-mockups.ts`, `customize-tool/server/print-render.ts`, `customize-tool/storefront/*`.
- Kiểu dữ liệu: `customize-tool/types/char.ts`, `types/index.ts`, `types/print.ts`.

## Quy trình
1. `cd /c/Users/b/code/flexiprint && git status && git pull --ff-only` (máy có sửa dở thì hỏi người dùng trước).
2. Tìm nguyên nhân (đọc code, thử lại tool, xem DB) — sửa gốc, không vá triệu chứng.
3. Sửa (Edit/Write; nếu hệ chặn file ngoài thư mục project thì sửa bằng Bash / `git apply` một patch viết trong project).
4. Kiểm tra: `npx tsc --noEmit -p tsconfig.json` sạch; `npx eslint <file đã sửa>` không lỗi mới. Thử lại bằng chính
   tool / trang đã lỗi nếu được.
5. Commit rõ ràng (tiếng Việt hoặc Anh, nói sửa gì và vì sao) → `git push origin main`.
6. Deploy (VPS `root@139.180.132.159`, app ở `/opt/flexiprint/app`):
   ```bash
   ssh root@139.180.132.159 'cd /opt/flexiprint/app && git status --short'
   ```
   Có file sửa tay trên VPS (ai đó sửa thẳng) → KHÔNG pull đè: sao lưu, commit phần đó lên nhánh, merge, rồi mới deploy.
   Sạch thì:
   ```bash
   ssh root@139.180.132.159 'cd /opt/flexiprint/app && git pull --ff-only && docker compose up -d --build app'
   ```
   Đổi `services/layer-kit` thì build thêm `layer-kit`. Migration SQL mới (`supabase/migrations/NNN_*.sql`):
   `ssh root@139.180.132.159 "docker exec -i supabase-db psql -U postgres -v ON_ERROR_STOP=1" < file.sql`.
   VPS chỉ 1.6 GB RAM: build mất vài phút, đừng build hai thứ cùng lúc.
7. Kiểm tra sau deploy: `curl -s -o /dev/null -w "%{http_code}" https://flexiprint.next.lc/` = 200/307, chạy lại việc đã
   lỗi. Báo người dùng: lỗi là gì, đã sửa ở đâu (file:dòng), commit nào, đã deploy chưa.

## DB
Supabase tự host trên VPS, schema `flexiprint`. Service role (MCP) không có quyền xoá một số bảng — việc xoá / sửa tay
dùng psql: `ssh root@139.180.132.159 "docker exec -i supabase-db psql -U postgres -c \"set search_path to flexiprint; …\""`.
Sửa đúng dòng cần sửa, ghi lại đã làm gì.

## Không làm
- Không deploy khi typecheck đỏ; không `git push --force`; không xoá dữ liệu người khác khi không được nhờ.
- Không in khoá / token ra chat.
