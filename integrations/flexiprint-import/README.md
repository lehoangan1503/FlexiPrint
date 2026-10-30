# flexiprint-import

MCP chạy **trên máy người dùng** (Claude Code): nói “import folder n00-POD-02 lên FlexiPrint” là xong — nó đọc folder
trên máy, tải lên flexi2 giống nút **Import bộ**, server dựng bộ nhân vật + sản phẩm rồi đưa lên Shopify (CHERIVIA) dạng
**bản nháp** và trả link xem thử bằng theme nháp.

Không chạy được trên agent @flexiprint (server công ty không đọc được ổ đĩa máy bạn) — nên là MCP local, như `linh-download`.

## Tool

| Tool | Việc |
|---|---|
| `flexiprint_import {folder, name?}` | Tải folder lên, chờ dựng xong + lên Shopify (tối đa ~12 phút). Trả `page` (bộ trên flexi2), `shopify.preview` (xem thử trên store, theme nháp), `shopify.admin`, `problems` |
| `flexiprint_import_status {set_id}` | Tiến độ / kết quả khi lần gọi trên chưa chờ hết |

`folder`: đường dẫn đầy đủ, `~/…`, hoặc chỉ tên folder (tìm trong `~/Downloads`, `~/Desktop`, `~/Downloads/linh-download-output`).
File gửi lên giống trang web: ảnh / json / csv / md / txt / font; bộ Teeinblue chỉ gửi các folder `teeinblue/<case>/`,
file ở ngoài cùng (mockup, ảnh mẫu, title-description.txt) và ghi chú — bản cắt sẵn ở lại máy.

## Cài (một lần)

1. Node 20+.
2. Tạo `integrations/flexiprint-import/.env` (hoặc copy cả folder này về máy, `.env` nằm cạnh `server.mjs`):

   ```
   FLEXI_URL=https://flexi2.next.lc
   FLEXI_ANON_KEY=<NEXT_PUBLIC_SUPABASE_ANON_KEY của flexi2 — khoá công khai, hỏi An>
   FLEXI_EMAIL=<tài khoản flexi2 của bạn>
   FLEXI_PASSWORD=<mật khẩu>
   ```

3. Thêm vào Claude Code:

   ```bash
   claude mcp add --scope user flexiprint-import -- node /đường/dẫn/tới/flexiprint-import/server.mjs
   ```

Thử không cần Claude Code: `node server.mjs import ~/Downloads/n00-POD-02` · `node server.mjs status <set_id>`.

## Sau khi import

- Sản phẩm Shopify luôn là **DRAFT** (khách không thấy). Bảng giá chọn theo chất liệu: bảng giá có chữ Acrylic / Glass /
  Ceramic… trong tên. Thiếu bảng giá → báo lỗi; tạo bảng giá rồi bấm **Đưa lên Shopify lại** ở trang bộ.
- Link xem thử có hạn; hết hạn thì bấm **Đưa lên Shopify lại**.
- Folder đã tải lên được xoá khỏi server khi dựng xong (chỉ giữ clipart cần cho sản phẩm) — sửa bố cục = import lại.
