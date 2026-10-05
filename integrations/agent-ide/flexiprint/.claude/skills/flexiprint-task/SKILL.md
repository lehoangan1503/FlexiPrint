---
name: flexiprint-task
description: Làm một task gửi từ app FlexiPrint (tin nhắn "[FlexiPrint task <id>]") — tạo danh mục, sửa danh mục theo phản hồi, hoặc kiểm tra prompt — và nộp kết quả cho người dùng duyệt.
---

# Làm task FlexiPrint

Người dùng đang chờ trên trình duyệt. Họ thấy từng dòng `report_progress` của bạn ngay lập tức.

## 1. Nhận việc
- `mcp__flexiprint__get_task(task_id)` → `kind`, `what`, `category` (trạng thái trong dialog, có thể chưa lưu),
  `note` (lời người dùng), `images` (ảnh kết quả đánh số #1…), `refUrls` (ảnh mẫu mới).
- Đọc `flexiprint://guide/task-results` (định dạng kết quả) nếu chưa đọc trong phiên này.
- `report_progress`: "Đã nhận việc — đang đọc danh mục".

## 2. Hiểu hiện trạng
- Có `savedCategoryId` → `get_category`, `get_history` (đã thử gì), `list_cliparts`.
- `view_image` trên `images` (tối đa 4 mỗi lần) và ảnh mẫu / ảnh thành phẩm liên quan. Nhìn kỹ — người dùng nói
  "hình 2" là ảnh số #2.
- `assemble_prompts(category)` để thấy prompt model ảnh đang nhận và các `leads` tự động.

## 3. Làm
- **revise** có `note`: tìm lớp gây lỗi (spec / style pack / vật liệu / chi tiết / ảnh thành phẩm) theo
  `flexiprint://guide/revise-rules`; chỉ sửa lớp đó; giữ nguyên từng chữ câu nào không sai.
- **revise** không có `note` = kiểm tra prompt: soát theo `flexiprint://guide/review-rules`, sửa xung đột thật.
- **create**: viết cả danh mục theo `flexiprint://guide/category-rules`; trước đó `list_style_packs`,
  `list_materials`, `list_product_details` để dùng lại.
- Thư viện chỉ có ở bản dùng chung: sửa style pack / vật liệu đang được danh mục khác dùng thì ghi rõ trong "why".
- Báo `report_progress` ở mỗi bước lớn (một dòng tiếng Việt).

## 4. Tự kiểm tra
- `assemble_prompts` với bản nháp (spec / style_prompt / details / materials) → đọc như model ảnh đọc.
  Không còn: hai mốc cho một vị trí, kích thước không đo được, câu "NOT in this picture" xoá mất chi tiết bắt buộc,
  thứ nằm sai lớp, ảnh thành phẩm mâu thuẫn.
- Khi thật cần (ví dụ không chắc vị trí lỗ treo): `run_studio` 1–3 ảnh, `get_run` đến khi xong, `view_image`.

## 5. Nộp
- `submit_result(task_id, result)` đúng định dạng — chẩn đoán / lý do bằng tiếng Việt, ngắn, nói rõ ảnh số mấy.
- Lỗi định dạng → đọc thông báo, sửa, nộp lại.
- Không làm được (thiếu thông tin, studio lỗi…) → `fail_task(task_id, lý do tiếng Việt)`.
- Ghi vài dòng vào `notes/<tên danh mục>.md`: đã đổi gì, vì sao, còn nghi ngờ gì.
