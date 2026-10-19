---
name: flexiprint-char
description: Làm bộ nhân vật / bộ ảnh khách v2 của FlexiPrint — task từ app ("[FlexiPrint task <id>] Bộ nhân vật v2 — …": brainstorm, master, auto, chat) HOẶC người trong công ty nhờ thẳng trên agent_ide làm trọn một sản phẩm custom từ ý tưởng / ảnh mẫu tới sản phẩm + mockup.
---

# Bộ nhân vật v2 (trang `/v2`)

Luật hệ thống: `flexiprint://guide/layer-rules` (khoá pixel — đọc trước). Một bộ = brief → MỘT master được duyệt →
búp bê giấy + từng lựa chọn vẽ lên búp bê (3b) → clipart = đúng phần pixel khác búp bê (3c) → sản phẩm (bước 4) →
mockup. Phần trang trí (ruy băng, số năm, cây thông…) và nền thì AI vẽ riêng, không cắt.

## Task từ app
`mcp__flexi2__get_task(task_id)` có `step`, `request`, toàn bộ bộ (brief, master, ảnh 3b, vùng 3c, file, sản
phẩm) và `instructions` — làm ĐÚNG theo `instructions` của bước đó.
- **brainstorm**: theo `briefRules` → `submit_result {summary, questions, ideas: [3 × {title, why, brief}]}`.
- **master**: viết prompt (từ `assembledPrompt`) → `char_draw_masters` → `char_wait` → `view_image` →
  `char_refine_master` (1 thay đổi mỗi lần) → `submit_result {summary, image_ids}`. Người dùng tự duyệt.
- **auto** (vừa duyệt master): tự làm hết 3a → 3b → 3c → bước 4 → mockup, kiểm tra mọi ảnh, tự vẽ lại ảnh sai, tới
  khi xong sản phẩm. Người dùng bấm "Dừng" = task bị huỷ, tool từ chối: dừng ngay.
- **chat**: người dùng gõ ở ô chat của trang (kèm ảnh chụp màn hình) — làm đúng yêu cầu, xem lại bằng `view_image`.
  Từ 2026-10-19 **bước 1 không còn form nhập**: bộ mới được mô tả hết trong ô chat (kèm ảnh mẫu). Brief còn trống →
  `view_image` mọi ảnh đính kèm → `char_add_reference {url}` từng ảnh → viết brief theo `briefRules` →
  `char_update_brief` → `char_draw_masters` (2) → `char_wait` → `view_image` → tóm tắt brief + bản master đề xuất.
  Người dùng tự duyệt master ở bước 2.

## Bộ vẽ riêng từng phiên bản (`lineup.drawn`)
Khách chọn số người (bà + 1…4 cháu) và mỗi số người phải là MỘT ẢNH RIÊNG (cắt từ ảnh đông người trông nham nhở):
`lineup {mode: "count", label, drawn: true}`. Bộ chính = bản đông nhất. Duyệt master bộ chính → server tạo **bộ
phiên bản** cho mỗi bản nhỏ hơn (`get_task set.versions`, mỗi bản có `set_id`) và vẽ 2 master từ master đã duyệt.
Agent: `view_image` → `char_approve_master {task_id, set_id, image_id}` (sai thì `char_refine_master` /
`char_draw_masters` với `set_id`). Duyệt xong server tự chạy 3a → 3b → 3c cho bản đó; agent soát ảnh 3b, ảnh sai →
`char_run_edits {set_id}` + `char_cut {set_id, what: "plan"}`. Sản phẩm tự dựng khi mọi bản cắt xong.
- **Nhóm (`slot.group`)**: cùng một loại phần của mọi nhân vật (tóc từng cháu, biểu cảm, trang phục) chung group →
  lựa chọn thứ k vẽ trong MỘT ảnh cho tất cả (role `group:<group>:<k>`).
- **Theme**: chooser `theme` (Christmas / Halloween / Easter). Trang phục = 1 slot shape mỗi nhân vật, part "outfit
  (hat and sweater)", `headwear: true` (nón thành lớp riêng NẰM TRÊN tóc), `group: "outfit"`, `restyle: true`,
  `follows: "theme"`. Tóc: `group: "hair"`, `on: "outfit"` (vẽ DƯỚI nón — không lòi tóc), 3 màu trong `colors`.
  Biểu cảm: part "face expression", `group: "face"` (búp bê mặt trống). Biển gỗ: element `place: "plaque"` (≈ 1/4
  chiều cao, tay tì lên), mỗi theme 1 option, `follows: "theme"`; câu trên biển: text `kind: "fixed"`, `place: "plaque"`.

## Làm trọn một bộ trên agent_ide (người dùng nhờ thẳng)
Cùng một phiên từ đầu tới cuối; người dùng theo dõi trên trang bộ và trong phiên này.
1. Đọc kỹ yêu cầu + mọi ảnh họ gửi (xem từng ảnh). Ảnh mẫu quyết định sản phẩm trông thế nào: khung hình (cả người /
   nửa người sau tấm biển — `framing`), tư thế, ai ở giữa, cái gì ở phía trước, trang trí, tên nằm đâu; lời họ viết
   đè lên ảnh; cái gì cả hai không nói mới dùng mặc định (cả người, đứng cạnh nhau). Thiếu điều quyết định (sản phẩm gì, kích thước, mấy nhân vật,
   khách đổi được gì) thì hỏi 1 lần, gọn.
2. `char_create_set {name, idea}` → **in link bộ** (`url`) cho người dùng. Ảnh họ gửi → `char_add_reference`
   (url, hoặc `image_base64` của file trong phiên; `use` sample/style/…; `note` = họ muốn lấy gì).
3. Khuôn in: `list_print_templates`; không có khuôn đúng kích thước thật thì `create_print_template` (thảm 120×40 cm
   ở 150 dpi, acrylic cắt viền…) — không dùng khuôn nhỏ cho sản phẩm to.
4. Brief: `get_task` (có `briefRules` cách viết) → `char_update_brief`. Có: subjects + slots (tóc / áo / quần / kính…,
   mode color / texture / shape), `lineup` (khách chọn 1 nhân vật / số người), `choosers` (nam/nữ từng cháu, có/không
   nón…) + `shownWhen`, slot `follows` (áo, nón đi theo Theme), `optional` (ô NO), `elements` (trang trí, `front`,
   `follows`, `box`), `texts` (input / choice / fixed; top/bottom/left/right/under/free/on), `backdrops` (`tile` cho
   hoạ tiết lặp), `charactersBox`, `mockups`. Tóm tắt brief cho người dùng (tiếng Việt, ngắn) và hỏi có cần thêm
   option gì không.
5. Master: `char_draw_masters` (2 bản) → `char_wait` → `view_image` → sửa / vẽ lại → gửi người dùng xem (link +
   số thứ tự) và **chờ họ chọn**. Họ chọn xong: `char_approve_master`.
6. Sau khi duyệt, làm hết như bước **auto** (instructions của `get_task`): 3b `char_run_edits` → soát từng ảnh (đúng 1
   phần thêm vào búp bê; không vẽ nền; không lộ hồng tím; phần mảnh vẽ đậm) → 3c `char_cut what "plan"` →
   `char_status` (mọi check đạt) → bước 4 `char_draw_backdrops` + `char_draw_elements` → `char_remake_product` →
   `render_artwork` vài tổ hợp → chỉnh bố cục (box) nếu chưa giống mẫu → `make_product_mockups` → xem.
   Báo tiến độ ngắn ở mỗi chặng (kèm link). Sai ở chặng nào thì tự sửa chặng đó.
7. Xong: gửi link bộ + link sản phẩm (`list_product_options` có editor url) + vài mockup, nói cái gì còn đáng xem lại.
   `submit_result` task đang mở. Người dùng muốn sửa thì `char_open_task` (hoặc dùng tiếp task cũ nếu còn mở).

## Lỗi của hệ thống
Tool trả lỗi lạ, sản phẩm sai do code (không phải do ảnh) → skill `flexiprint-dev`: sửa code, deploy, làm tiếp.
