---
name: flexiprint-pack-image
description: Làm task "Tạo ảnh với AI" của thư viện ảnh tổ hợp (tin nhắn "[FlexiPrint task <id>] Tạo ảnh cho thư viện ảnh tổ hợp") — hiểu đúng yêu cầu, tạo từng ảnh bằng generate_pack_image, tự xem và sửa, rồi nộp ảnh.
---

# Tạo ảnh cho thư viện ảnh tổ hợp

Người dùng ghép mockup sản phẩm bằng tay từ các layer: nền, sản phẩm, tay / ngón tay cầm sản phẩm, đạo cụ. Ảnh bạn
tạo vào thư viện để họ kéo vào Image frame. Họ thấy từng dòng `report_progress` và từng ảnh bạn tạo ngay trên dialog.

## 1. Nhận việc
- `mcp__flexiprint__get_task(task_id)` → `description` (lời người dùng), `refUrls` (ảnh tham khảo), `aspect`,
  `base` (ảnh cần chỉnh tiếp, nếu có), `made` (ảnh đã tạo trong task này), `questions`, `instructions`.
- `view_image` mọi ảnh tham khảo và `base`.
- `report_progress`: "Đã nhận việc — đang đọc yêu cầu".

## 2. Hiểu đúng yêu cầu (quan trọng nhất)
- Đếm số ảnh RIÊNG cần tạo ("2 tấm… tổng cộng 4 tấm" = 4 ảnh). Mỗi ảnh: chủ thể, chỉ phần nào (chỉ ngón trỏ + giữa;
  chỉ ngón cái), tay trái / phải, đi vào khung từ đâu (góc dưới trái, mép trên…), chủ đề (nail Giáng Sinh…).
- **Layer** (đặt chồng lên / dưới sản phẩm: ngón tay, bàn tay, đạo cụ) → `transparent: true` (vẽ trên nền trơn rồi
  tách nền). Nền / cảnh → `transparent: false`.
- Thật sự mơ hồ (số ảnh, phần nào tách riêng) → `ask_user` một lần với phương án cụ thể, rồi kết thúc lượt.

## 3. Tìm trước
- `list_pack_images` — có ảnh hợp sẵn thì dùng lại (đưa id vào `image_ids`).

## 4. Tạo
- Mỗi ảnh một prompt tiếng Anh chính xác: có gì và KHÔNG có gì trong khung ("only the thumb and the base of the palm,
  no other fingers"), tư thế, khung hình và mép đi vào, da / móng / chất liệu, ánh sáng hợp ảnh tham khảo, chân thực.
- Các ảnh đi cùng nhau (ngón trỏ+giữa và ngón cái kẹp sản phẩm) phải khớp: tạo ảnh đầu, rồi đưa url của nó vào `refs`
  của ảnh sau, viết "same hand, same skin tone, same nails, same lighting as Reference image 1".
- Chỉnh tiếp `base`: đưa url của nó đầu tiên trong `refs`, nói rõ đổi gì và giữ gì.
- `generate_pack_image(task_id, name, prompt, refs, aspect, transparent)` — khoảng 1 phút / ảnh, tốn tiền.

## 5. Tự kiểm tra
- `view_image` từng ảnh: đúng ngón, đúng tay, đúng chủ đề, đúng mép, tách nền sạch. Sai → sửa prompt, tạo lại
  (tối đa ~3 lần mỗi ảnh).

## 6. Nộp
- `submit_result(task_id, {summary, image_ids})` — `summary` tiếng Việt: đã tạo gì, ảnh nào là ảnh nào, còn gì chưa
  ổn; `image_ids` = ảnh cuối cùng theo thứ tự hợp lý. Ảnh nháp không nộp sẽ không vào thư viện.
- Không làm được → `fail_task(task_id, lý do tiếng Việt)`.
