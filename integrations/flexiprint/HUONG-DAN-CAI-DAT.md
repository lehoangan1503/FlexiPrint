> **Dùng Agent IDE?** Không cần cài gì: Store → nhận món `flexiprint-user`, rồi Cài đặt → Tool catalog → flexiprint-user → dán email + mật khẩu flexi2. File này chỉ dành cho máy dùng Claude Code không qua Agent IDE.

# Cài MCP `flexiprint` — làm sản phẩm FlexiPrint (flexi2) từ đầu đến cuối bằng lệnh chat

> **Gửi agent (Claude Code):** đọc hết file này rồi làm đúng các bước ở phần **"Việc agent cần làm"**.
> **Máy đã cài `flexiprint-import` (bản cũ)?** Làm các bước dưới, giữ nguyên email/mật khẩu trong `.env` cũ, rồi gỡ bản cũ:
> `claude mcp remove --scope user flexiprint-import`. Mọi tool của bản cũ có trong bản này, cùng tên.

## Nó là gì

- Một MCP duy nhất, chạy **trên máy người dùng**, đăng nhập bằng tài khoản flexi2 của người đó.
- Việc cần ổ đĩa máy mình thì làm ngay trên máy: import folder bộ, đưa ảnh từ máy lên, lưu mockup / file in về máy.
- Mọi việc khác (thư viện clipart, artwork, sản phẩm, mockup, deploy Shopify, bộ nhân vật) chuyển lên server flexi2 —
  danh sách tool lấy thẳng từ server nên server thêm tool nào thì máy có tool đó, không phải cài lại.
- Quyền: sửa được artwork / sản phẩm / bộ của chính mình; tài khoản admin sửa được tất cả. Deploy được ACTIVE (bán thật).
- Không cần build, không cần `npm install`: 1 file `server.mjs`, cần **Node 20+**.

## Việc agent cần làm

1. Kiểm tra `node -v` ≥ 20. Nếu thiếu thì cài Node 20+ (hỏi người dùng trước).
2. Tạo folder `~/.claude/flexiprint/` và tải file:

   ```bash
   mkdir -p ~/.claude/flexiprint && curl -fsSL https://flexi2.next.lc/flexiprint-mcp.mjs -o ~/.claude/flexiprint/server.mjs
   ```

3. Tạo file `~/.claude/flexiprint/.env` (đã có `~/.claude/flexiprint-import/.env` thì chép sang):

   ```
   FLEXI_URL=https://flexi2.next.lc
   FLEXI_EMAIL=
   FLEXI_PASSWORD=
   ```

   **Hỏi người dùng** email + mật khẩu tài khoản flexi2 (đăng nhập ở https://flexi2.next.lc) rồi điền vào. Không in mật khẩu ra màn hình. `chmod 600` file này.
4. Thử: `node ~/.claude/flexiprint/server.mjs tools` — in ra danh sách tool (khoảng 80 dòng, có `deploy_product`).
   - Báo *"Đăng nhập flexi2 lỗi"* → sai email/mật khẩu, hỏi lại.
   - Chỉ in 4 tool `flexiprint_*` → không tới được server; xem lỗi in kèm.
5. Thêm MCP vào Claude Code:

   ```bash
   claude mcp add --scope user flexiprint -- node ~/.claude/flexiprint/server.mjs
   ```

   (Nếu `~` không được mở rộng thì dùng đường dẫn đầy đủ.) Kiểm tra: `claude mcp list` thấy `flexiprint ✓ Connected`.
6. Báo người dùng: **thoát Claude Code rồi mở lại** (MCP mới chỉ có ở phiên mới).

Cập nhật bản mới: chạy lại lệnh `curl` ở bước 2 rồi mở lại Claude Code.

## Cách dùng

Nói tự nhiên, ví dụ:

- *"import folder n00-POD-02 lên FlexiPrint"*
- *"làm sản phẩm ornament acrylic từ artwork X, tạo mockup rồi deploy lên Cherivia"*
- *"tạo 4 mockup cho sản phẩm Y, lưu về máy"*
- *"làm một bộ nhân vật mới: bà và 1–4 cháu, acrylic trong, ảnh mẫu ở ~/Desktop/mau.png"*

Tool chạy trên máy:

| Tool | Việc |
|---|---|
| `flexiprint_import {folder, name?}` | Tải folder / zip bộ lên, chờ dựng + lên Shopify bản nháp (tối đa ~12 phút) |
| `flexiprint_import_status {set_id}` | Tiến độ khi lần gọi trên chưa chờ xong |
| `flexiprint_upload_image {path}` | Ảnh trên máy → link, để đưa cho tool cần ảnh |
| `flexiprint_save_files {urls, folder?}` | Tải file theo link về máy (mặc định `~/Downloads/flexiprint`) |

Trình tự làm sản phẩm (tool server): `list_base_products` → `create_artwork_product` / `set_artwork_layers` →
`make_product_from_artwork` → `make_product_mockups` → `wait_product_mockups` → `check_deploy` → `deploy_product`.
Bộ nhân vật: `char_create_set` (bộ mới) hoặc `char_open_task` (bộ có sẵn) cho `task_id`, rồi các tool `char_*`.
Hướng dẫn đầy đủ: tool `read_guide`.

## Server đọc folder thế nào

Có 2 đường, tự chọn theo nội dung folder:

1. **Bản giao Teeinblue — server tự đọc, không cần AI.** Folder có ít nhất một file `teeinblue.json`, ở **bất kỳ cấp
   thư mục con nào** (vd. `n00-POD-02/teeinblue/c1-qua/teeinblue.json` — mỗi case một folder, trong đó là các lớp ảnh +
   `print/` + `fonts/`). Server đọc thẳng các json đó ra canvas, lớp, lựa chọn, chữ → dựng bộ + sản phẩm ngay (vài phút).
2. **Định dạng lạ — @flexiprint phân tích.** Không có `teeinblue.json` nào (vd. folder phẳng `teeinblue-clipart-NN-…png`
   + `bang-vi-tri.csv` + ghi chú): trang bộ báo *"@flexiprint đang phân tích folder (định dạng lạ)"*. Agent dùng MCP
   `char_import_files` (danh sách file, mỗi lần ≤ 300 file, link = `url_base` + path) → `char_import_read` (đọc json /
   csv / md / txt theo đoạn 30 000 ký tự) → xem vài ảnh lớp → tự viết manifest → `char_import_build`. Chậm hơn và có thể
   hỏi lại; agent kẹt thì nhắn vào chat của bộ (vd. "dựng lại bộ import này").

Muốn nhanh và chắc thì gửi bản giao Teeinblue có `teeinblue.json`.

## Sau khi import

- Sản phẩm Shopify luôn là **DRAFT** (khách không thấy). Bảng giá chọn theo chất liệu (tên bảng giá có Acrylic / Glass / Ceramic…). Thiếu bảng giá → báo lỗi; tạo bảng giá rồi bấm **Đưa lên Shopify lại** ở trang bộ.
- Link xem thử có hạn; hết hạn → bấm **Đưa lên Shopify lại** (hoặc gọi lại `flexiprint_import_status`).
- Folder tải lên bị xoá khỏi server khi dựng xong (chỉ giữ clipart cần cho sản phẩm) — muốn đổi bố cục thì import lại.
- **Ảnh lựa chọn (thumb) sai / trống**: nhắn @flexiprint trong chat của bộ *"làm lại thumb"* — tool MCP `char_import_rethumb`
  làm lại mọi thumb từ clipart thư viện (không cần tải folder lại) rồi publish lại sản phẩm; lựa chọn không có file (vd. mắt
  mặc định vẽ sẵn trong lớp da) thì agent đặt thumb bằng một vùng cắt của file khác. Thumb dựng trước 2026-11-02 bị cắt sai
  (hình dẹt / cao mất 2 đầu) — chạy lại là đúng.
- **Mô tả** có thể là HTML hoặc chữ thường (**đậm**, gạch đầu dòng "- ", tiêu đề "### "); lên Shopify hiện trong mục
  *Description* của trang sản phẩm (theme nháp giờ có giao hàng dự kiến, 3 dòng cam kết, các mục thu gọn như store chính).

## Lỗi hay gặp

| Lỗi | Xử lý |
|---|---|
| `Thiếu FLEXI_EMAIL / FLEXI_PASSWORD / FLEXI_ANON_KEY` | Điền đủ `.env` (bước 4) |
| `Đăng nhập flexi2 lỗi` | Sai email/mật khẩu flexi2 |
| `Không thấy folder / file .zip "…"` | Đưa đường dẫn đầy đủ |
| Tool không xuất hiện | Chưa mở lại Claude Code, hoặc `claude mcp list` báo lỗi → chạy thử `node ~/.claude/flexiprint/server.mjs tools` xem lỗi |
| Chờ quá 12 phút | Bình thường với bộ lớn — gọi `flexiprint_import_status {set_id}` sau vài phút |

