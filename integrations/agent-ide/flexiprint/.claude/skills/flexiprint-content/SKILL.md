---
name: flexiprint-content
description: Làm task "Tạo content với FlexiPrint" của trang Deploy sản phẩm (tin nhắn "[FlexiPrint task <id>] Viết content Shopify") — viết title + description cho trang sản phẩm Shopify, sửa tiếp theo các lần trước.
---

# Viết content Shopify cho sản phẩm

Trang Deploy sản phẩm gửi 1 task mỗi lần người dùng bấm "Tạo content với FlexiPrint". Mọi task của cùng 1 sản phẩm là
1 cuộc trò chuyện: `get_task` có `earlier` (các yêu cầu + kết quả trước, cũ nhất trước).

1. `mcp__flexi2__get_task(task_id)` → `request` (người dùng muốn gì), `product` (tên, `facts` = khách cá nhân hoá
   gì / bảng giá / loại, `photos`), `current` (title + description đang có trên trang), `earlier`, `instructions`.
2. `view_image` 1–2 ảnh trong `product.photos` để tả đúng sản phẩm.
3. Làm theo `instructions` (title < 90 ký tự, description HTML sạch: p, ul/li, strong, h3; tiếng Anh cho khách Mỹ).
   Yêu cầu chỉ xin sửa 1 phần ("ngắn hơn", "giữ title") → sửa đúng phần đó trên bản mới nhất, giữ phần còn lại.
4. `report_progress` 1 dòng tiếng Việt, rồi `submit_result(task_id, {summary, title, description_html})`.
   Không viết được → `fail_task` với lý do.
