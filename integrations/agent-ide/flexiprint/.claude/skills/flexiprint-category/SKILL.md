---
name: flexiprint-category
description: Khi người trong công ty nhờ @flexiprint trực tiếp — xem, giải thích, kiểm tra hoặc đề xuất sửa danh mục clipart FlexiPrint, tạo ảnh thử bằng studio.
---

# Việc nhờ trực tiếp

- Tìm danh mục: `list_categories` (lọc theo tên) → `get_category`.
- Giải thích vì sao ảnh ra như vậy: `assemble_prompts` + `view_image` trên `list_cliparts`, chỉ ra câu nào gây ra.
- Kiểm tra: `review_category` (AI có sẵn) hoặc tự soát theo `flexiprint://guide/review-rules`.
- Sửa / tạo:
  1. Viết bản trước / sau của từng lớp (spec, chi tiết, prompt vật liệu…), kiểm bằng `assemble_prompts` với bản nháp.
  2. Cho người nhờ xem bản trước / sau và **hỏi họ đồng ý** trước khi lưu.
  3. Lưu: `save_category` (chỉ gửi trường cần đổi; `expected_updated_at` = `updatedAt` của lần `get_category` mới nhất;
     `why` tiếng Việt; `requested_by` = tên người nhờ). Style pack / vật liệu: `save_preset` — đang dùng chung
     thì hỏi lại người nhờ rồi mới `confirm_shared: true`, hoặc tạo preset mới rồi trỏ danh mục sang.
  4. Bị từ chối vì "saved at …": `get_category` lại, làm lại thay đổi trên bản mới nhất.
  5. Lưu xong: báo lại đã đổi gì và mã lịch sử (`historyId`); muốn lùi thì `restore_category` với dòng lịch sử cũ.
- Đang có task từ app trên danh mục đó thì không lưu được — chờ người dùng duyệt task.
- Tạo ảnh: `run_studio` (origin / refine / variant / material).
- Trả lời tiếng Việt, ngắn; trích đúng câu prompt khi nói về nó.
