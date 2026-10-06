---
name: flexiprint-pack-image
description: Làm task "Tạo ảnh với AI" của thư viện ảnh tổ hợp (tin nhắn "[FlexiPrint task <id>] Tạo ảnh cho thư viện ảnh tổ hợp") — hiểu đúng yêu cầu, tạo từng ảnh bằng generate_pack_image, tự xem và sửa, rồi nộp ảnh.
---

# Tạo ảnh cho thư viện ảnh tổ hợp

Người dùng ghép mockup sản phẩm bằng tay từ các layer: nền, sản phẩm, tay / ngón tay cầm sản phẩm, đạo cụ. Ảnh bạn
tạo vào thư viện để họ kéo vào Image frame. Họ thấy từng dòng `report_progress` và từng ảnh bạn tạo ngay trên dialog.

## 1. Nhận việc
- `mcp__flexiprint__get_task(task_id)` → `description` (yêu cầu chung), `refUrls` (ảnh tham khảo), `aspect`,
  `bases` (các ảnh cần chỉnh tiếp, mỗi ảnh một `note` riêng), `made` (ảnh đã tạo trong task này), `questions`, `instructions`.
- `view_image` mọi ảnh tham khảo và mọi ảnh trong `bases`.
- `report_progress`: "Đã nhận việc — đang đọc yêu cầu".

## 2. Hiểu đúng yêu cầu (quan trọng nhất)
- Đếm số ảnh RIÊNG cần tạo ("2 tấm… tổng cộng 4 tấm" = 4 ảnh). Mỗi ảnh: chủ thể, chỉ phần nào (chỉ ngón trỏ + giữa;
  chỉ ngón cái), tay trái / phải, đi vào khung từ đâu (góc dưới trái, mép trên…), chủ đề (nail Giáng Sinh…).
- **Layer** (đặt chồng lên / dưới sản phẩm: ngón tay, bàn tay, đạo cụ) → `transparent: true` (vẽ trên nền trơn rồi
  tách nền). Nền / cảnh → `transparent: false`.
- **Ảnh chỉnh tiếp (`bases`)**: mỗi ảnh có `note` = yêu cầu RIÊNG của người dùng cho đúng ảnh đó. Note thắng yêu cầu
  chung ở mọi chỗ mâu thuẫn, và chỉ áp cho ảnh đó — không mang sang ảnh khác, không gộp các note vào một prompt.
  Trước khi tạo, ghi cho mình một dòng mỗi ảnh: note đòi gì, yêu cầu chung thêm gì (chỉ chỗ note không nói khác), cái gì
  phải giữ nguyên. Mỗi ảnh phải có một bản chỉnh riêng: `generate_pack_image(parent_id = id ảnh đó, url của nó đứng
  đầu refs, cùng transparent)` — `submit_result` từ chối nếu thiếu ảnh nào. Ảnh không có note thì chỉnh theo yêu cầu chung.
- Thật sự mơ hồ (số ảnh, phần nào tách riêng) → `ask_user` một lần với phương án cụ thể, rồi kết thúc lượt.

## 2b. Tách ảnh có sẵn thành layer — KHÔNG vẽ lại
- "Tách ngón cái ra", "tách thành 2 lớp"… phải giữ đúng pixel của ảnh; vẽ lại thì không bao giờ khớp. Bạn không có tool
  cho việc này: đừng vẽ lại — nói người dùng tách trong tổ hợp bằng công cụ **Cắt** (lasso): nhân bản layer, một bản
  giữ vùng khoanh, một bản bỏ vùng khoanh (trong summary, hoặc `ask_user` nếu đó là toàn bộ yêu cầu).

## 2c. Bộ ảnh
- `get_task.collection` = bộ ảnh của yêu cầu: `earlier` (các yêu cầu trước, tóm tắt, ảnh) và `photos` (ảnh của bộ trong
  thư viện). "Ảnh trước", "cặp đó", "như lần trước" là nói về chúng.

## 3. Tìm trước
- `list_pack_images` — có ảnh hợp sẵn thì dùng lại (đưa id vào `image_ids`).

## 4. Tạo
- Mỗi ảnh một prompt tiếng Anh chính xác: có gì và KHÔNG có gì trong khung ("only the thumb and the base of the palm,
  no other fingers"), tư thế, khung hình và mép đi vào, da / móng / chất liệu, ánh sáng hợp ảnh tham khảo, chân thực.
- Các ảnh đi cùng nhau (ngón trỏ+giữa và ngón cái kẹp sản phẩm) phải khớp: tạo ảnh đầu, rồi đưa url của nó vào `refs`
  của ảnh sau, viết "same hand, same skin tone, same nails, same lighting as Reference image 1".
- Chỉnh một ảnh trong `bases`: url của nó đầu tiên trong `refs`, `parent_id` = id của nó; prompt nói rõ đổi gì (theo
  note trước) và giữ gì.
- `generate_pack_image(task_id, name, prompt, refs, aspect, transparent)` — khoảng 1 phút / ảnh, tốn tiền.
- "Y chang nhưng cho tay bên kia" = `mirror_pack_image(task_id, image_id, name)` trên ảnh đã hoàn thiện: lật trái ↔ phải
  thật từng pixel, tức thì, không tốn tiền. KHÔNG bao giờ viết prompt "mirror / flip" cho model — nó trả lại y nguyên
  tay cũ (đã xảy ra: "tay phải" ra vẫn là tay trái).

## 5. Tự kiểm tra
- `view_image` từng ảnh (ảnh được thu nhỏ để xem, vùng trong suốt hiện màu xám): đúng ngón, đúng tay (cặp tay
  trái / phải mà hai ảnh cùng chiều là sai), đúng chủ đề, đúng mép, tách nền sạch. Sai → sửa prompt, tạo lại
  (tối đa ~3 lần mỗi ảnh).

## 6. Nộp
- `submit_result(task_id, {summary, image_ids})` — `summary` tiếng Việt: đã tạo gì, ảnh nào là ảnh nào, với MỖI ảnh
  chỉnh tiếp: note của nó và đã áp thế nào, còn gì chưa ổn; `image_ids` = ảnh cuối cùng theo thứ tự hợp lý. Ảnh nháp không nộp sẽ không vào thư viện.
- Không làm được → `fail_task(task_id, lý do tiếng Việt)`.
