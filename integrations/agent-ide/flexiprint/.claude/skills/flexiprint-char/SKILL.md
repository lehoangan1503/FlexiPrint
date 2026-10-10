---
name: flexiprint-char
description: Làm task bộ nhân vật v2 của app FlexiPrint (tin nhắn "[FlexiPrint task <id>] Bộ nhân vật v2 — …") — brainstorm brief, viết prompt + tạo + tự duyệt master, viết prompt + chạy + kiểm tra ảnh AI tô vùng clipart (bước 3b) — clipart được cắt đúng theo vùng tô đó.
---

# Bộ nhân vật v2

Trang `/v2` gửi 1 task cho mỗi bước. Mọi task của cùng 1 bộ là 1 cuộc trò chuyện (`get_task` có `earlier`).
Đọc `flexiprint://guide/layer-rules` trước (skill `flexiprint-layers`): sau master, MỌI ảnh là sửa tại chỗ của master.

1. `mcp__flexiprint__get_task(task_id)` → `step` (brainstorm | master | edits), `request`, `project.brief`,
   `references` (ảnh tham khảo người dùng thả vào brief: `use` = sample (sản phẩm mẫu hoàn chỉnh — đọc hết: sản phẩm, phong cách, nhân vật, chữ, trang trí) | style | character | outfit | pose | product |
   avoid + `editorNote` = họ muốn lấy gì), `blankProduct`, `masters`, `edits` (bước edits), `instructions`.
   **Luôn `view_image` từng ảnh tham khảo và làm theo ghi chú của nó**; style/character/outfit/pose được tự gửi kèm
   khi vẽ master, prompt không được nói ngược với ảnh.
   Làm ĐÚNG theo `instructions` của bước đó.
2. **brainstorm**: theo `briefRules` → `submit_result {summary, questions, ideas: [3 × {title, why, brief}]}`.
3. **master**: viết prompt (bắt đầu từ `assembledPrompt`) → `char_draw_masters` → `char_wait` → `view_image` →
   `char_refine_master` (1 thay đổi mỗi lần) hoặc vẽ lại → `submit_result {summary, image_ids}` (đề xuất, người
   dùng tự duyệt). Có `imageId` = sửa đúng master đó theo `request`.
4. **edits** (trang: "3b. AI tô vùng clipart" — vùng tô / kiểu vẽ tại chỗ CHÍNH LÀ vùng cắt clipart, layer-rules §9b):
   Project mới (`clipMode: "key"`, trang: "3b. AI tạo clipart"): mỗi clipart = 1 ảnh — giữ đúng phần đó, mọi thứ
   khác thành bóng hồng phẳng, nền trong suốt (server tự thêm `keySentence`). Viết "Turn EVERYTHING magenta except
   the <part>…" và GỌI TÊN + MÀU từng phần khác của người đó (áo khoác vàng, giày đỏ, ly rượu…) — viết "chỉ giữ váy"
   thì model giữ luôn áo khoác. Không bao giờ bảo vẽ phần đó một mình trên nền trống (model vẽ bừa chỗ khác). base =
   búp bê giấy bỏ mọi phần đổi được (layer-rules §9a) — chỉ dùng làm lớp thân. MỌI option vẽ từ master: "Take OFF the
   <part> (<kiểu hiện tại>) and give her a completely DIFFERENT one: … Nothing of the <kiểu hiện tại> stays…" rồi tô hồng
   mọi thứ trừ nó (vẽ trên búp bê giấy thì model phóng to + đổi tay → lệch). Kiểm tra: chỉ phần đó có màu, hồng phẳng
   không nét, nền trong suốt, option khác hẳn kiểu mặc định.
   mỗi `role` 1 prompt (đúng 1 thay đổi, nói rõ nhân vật nào, giữ nguyên mọi thứ khác; tô magenta
   #FF00FF phủ HẾT phần đó) → `char_run_edits {prompts: {role: prompt}}` (base trước nếu thiếu) → `char_wait` →
   `view_image` → làm lại bản sai → `submit_result {summary, image_ids}`.
5. `report_progress` (tiếng Việt) trước mỗi lượt tạo ảnh. Không làm được → `fail_task` với lý do.
   Không bao giờ duyệt master thay người dùng.

Tách nền và vùng của từng lớp do người dùng duyệt / sửa tay trên trang (bước 3); agent không sửa file layer.
"Tạo bộ custom" (3c) cắt clipart theo vùng tô 3b rồi ráp luôn 1 sản phẩm hoàn chỉnh trong editor — tô sai thì clipart sai, nên tô phủ HẾT phần đó và không lấn sang phần khác.
