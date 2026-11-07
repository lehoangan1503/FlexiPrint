# FlexiPrint (flexi2) — Cơ chế mới: Product base · Artwork · Sản phẩm

> Bản có hình: https://flexi2.next.lc/huong-dan

Ngày 2026-11-07. Áp dụng cho https://flexi2.next.lc. Viết cho cả team: người làm thiết kế, người lên sản phẩm, sếp.

---

## 1. Tóm tắt trong 30 giây

Hệ thống giờ có **3 thứ**, giống hệt cách Teeinblue chia:

| flexi2 | Teeinblue | Là gì | Giữ cái gì |
|---|---|---|---|
| **Product base** | Product Base | Loại sản phẩm trơn đem bán: *Acrylic Ornament 1 side*, *Glass Ornament 1 side*, *Ceramic Ornament 2 sides*, *Poseable Doll* | Biến thể (size × pack) + **giá** (bảng giá Notion), khuôn in + phôi trơn của loại đó, print area, xưởng |
| **Artwork** | Artwork | **Một thiết kế hoàn chỉnh** | Mọi layer, clipart, option cho khách chọn (personalize), khuôn in, phôi trơn, preview, **file in** |
| **Sản phẩm** | Campaign | Thứ lên Shopify | Artwork + Product base, tên theo chủ đề, mockup, link Shopify |

```
   Product base (giá + biến thể)  ─┐
                                    ├──►  SẢN PHẨM  ──►  Shopify
   Artwork (personalize + file in) ─┘     (mockup, tên, deploy)
```

- **Artwork** lo phần **personalize + file in**.
- **Product base** lo phần **giá + size/biến thể**.
- **Sản phẩm** = ghép 2 cái trên. Trang sản phẩm: **bên trái mockup**, **bên phải giá + form personalize** đúng như
  khách thấy trên store.

---

## 2. So sánh với Teeinblue

### 2.1 Giống nhau

| | Teeinblue | flexi2 |
|---|---|---|
| Product base | Tiêu đề, fulfillment, print area, bảng variants + giá, mockups | Tiêu đề = loại sản phẩm, xưởng + catalog ID, print area, biến thể + giá (bảng Notion), mockups |
| Mockup ở product base | Gom từ các campaign dùng base | Gom từ các sản phẩm dùng base (ban đầu trống) |
| Artwork | Canvas + layer + option + preview + file in | Như vậy |
| Preview only / Print only | 2 nhóm layer "Preview (preview only)" và "Print (Order only)" | Mỗi layer có ô **Hiện ở**: *Preview + file in* / *Chỉ preview* / *Chỉ file in*; phôi trơn luôn chỉ ở preview, khuôn in luôn chỉ ở file in |
| Silhouette acrylic | Hình khối **full đen** ở nửa trên, bản in ở nửa dưới | Như vậy (công tắc **Silhouette** ở tab File in) + file silhouette khuôn full đen riêng trong gói file in |
| Campaign / Sản phẩm | Step 1 chọn base + artwork, Step 2 trái mockup, phải giá + form | Tạo sản phẩm = chọn artwork + base; trang sản phẩm trái mockup, phải giá + form |
| Sửa artwork sau khi đã lên sản phẩm | Phải "Update campaign" | Sản phẩm giữ bản cũ; hiện badge **"Có bản artwork mới"** → bấm cập nhật (từng cái hoặc hàng loạt) |

### 2.2 Khác nhau — và vì sao bản chất vẫn giống

**Teeinblue gộp mọi thứ vào 1 canvas.** Một artwork "No Place Like Grandma's — 3 Grandkids" có **689 layer** trong 1
danh sách phẳng: 334 layer ảnh "Print", 333 layer ảnh "Preview" (gần như nhân đôi), 9 layer chữ (3 cho form, 3 cho
print, 3 cho preview), 11 layer chọn clipart. Mỗi option (da 1 × áo bánh gừng, da 1 × áo cây thông…) là **một layer
riêng** có điều kiện "hiện khi…". Canvas 1000×2000: nửa trên là silhouette + preview, nửa dưới là bản in. Rất khó nhìn,
sửa 1 chỗ phải sửa cả bản Print lẫn bản Preview.

**flexi2 tách theo version.** Cùng nội dung đó, flexi2 chia:

- **Version** (cột trái editor): mỗi trường hợp lớn khách chọn đầu tiên (1 cháu / 2 cháu / 3 cháu; bé trai / bé gái)
  là 1 version có bộ layer riêng → nhìn version nào thấy đúng version đó.
- **Layer có option**: 1 layer "Chọn — Áo cháu 1" chứa mọi lựa chọn áo, thay vì 12 layer có điều kiện.
- **Layer đi theo (linked)**: tóc sau đi theo tóc trước, đầu đi theo thân → không phải tạo điều kiện bằng tay.
- **Không nhân đôi Print / Preview**: chỉ có 1 bộ layer. Preview = bộ layer đó đặt lên phôi trơn; file in = bộ layer đó
  cắt theo khuôn. Chỉ layer thật sự khác nhau mới đánh dấu *Chỉ preview* / *Chỉ file in*.

**Cuối cùng giống nhau:** cả hai đều cho ra (1) 1 form personalize cho khách, (2) 1 preview trên phôi, (3) 1 file in
đúng khuôn. flexi2 chỉ tổ chức gọn hơn: 1 artwork lớn chứa nhiều version, thay vì 1 canvas khổng lồ.

---

## 3. Lưu ý quan trọng: artwork trên Teeinblue hiện chưa nhất quán, chưa chuẩn

Khi xem lại store Cherivia trên Teeinblue (2026-11-07) thấy:

- **Không cùng một cách làm**: artwork acrylic có silhouette nửa trên + bản in nửa dưới (1000×2000); artwork ornament
  sứ / kính thì chỉ có 1 mặt in, có cái có "Print guide template" (ẩn), có cái không.
- **Thiếu phôi trơn / khuôn in rõ ràng**: một số artwork không có layer phôi trơn để preview, hoặc không có khuôn in
  làm chuẩn (chỉ có "Print guide template" bị ẩn, hoặc không có gì) — preview và file in dựa vào việc người làm tự căn.
- **Product base lộn xộn**: base "Rainbow Bridge Ceramic Ornament 5 Backgrounds TEST" có 5 print area cùng tên "Front";
  base wood ornament có 3 print area trong đó 1 cái 7500×1500; base ceramic 2 mặt còn ghi "SKU 2 mặt CHƯA XÁC NHẬN";
  nhiều campaign tên "test".
- **Layer Print và Preview nhân đôi bằng tay**: phải giữ 2 bản khớp nhau bằng tay (vd. chữ "Print Name" 31px ở nửa
  dưới, "Preview Name" 28px ở nửa trên, cùng lấy chữ từ 1 ô form) — sửa bản này dễ quên bản kia.

**Quy tắc của flexi2 (bắt buộc):** một artwork chỉ được coi là hoàn chỉnh khi có **khuôn in** và **phôi trơn** rõ
ràng. Cột Layers của editor luôn có 2 dòng cố định:

- `Preview only · Phôi trơn` — ảnh sản phẩm trơn, thiết kế đặt lên đó ở tab Xem trước và để tạo mockup. **Không bao giờ
  vào file in.**
- `Print only · Khuôn in` — hình dạng thật của sản phẩm (đường cắt, lỗ treo, vùng an toàn). **Không bao giờ hiện trên
  preview.**

Thiếu cái nào thì dòng đó báo **"thiếu"** màu vàng. Artwork thiếu khuôn hoặc phôi thì ghép với product base sẽ **không
ra được file in chuẩn** → phải bổ sung trước khi tạo sản phẩm.

---

## 4. Bộ clipart, bộ import và artwork

- **Một bộ import (folder Teeinblue, zip) bản chất đã là 1 artwork hoàn chỉnh**: đủ layer, option, chữ, vị trí. Import
  xong flexi2 tạo ra **artwork** (mở ở tab Artwork) — **không tự tạo sản phẩm, không tự lên Shopify nữa**.
- Đồng thời flexi2 cắt các file của bộ thành **clipart** trong Thư viện. Clipart để **tái sử dụng**: kéo bộ vào một
  artwork khác khi muốn thiết kế thủ công (ví dụ dùng lại nhân vật bà + cháu cho 1 thảm, 1 túi).
- **Bộ clipart tự vẽ** (Thư viện → Tạo bộ clipart mới) cũng vậy: làm xong là có clipart + 1 artwork hoàn chỉnh, vì
  bộ đã ra hết các option personalize. Không tạo thẳng sản phẩm.
- Muốn bán → **Tạo sản phẩm** từ artwork đó (mục 5.4).

---

## 5. Thao tác từng bước

### 5.1 Dashboard

`/dashboard` có 4 tab: **Sản phẩm · Artwork · Product base · Thư viện**.

- **Sản phẩm**: thứ đã / sẽ bán. Mỗi thẻ ghi product base + artwork nguồn, badge *Đã deploy*, *Artwork mới*.
- **Artwork**: mỗi thẻ là 1 artwork (đủ mọi version), số sản phẩm đang dùng nó; nút túi xách trên thẻ = *Tạo sản
  phẩm từ artwork này*. Trên cùng: *Import bộ clipart*, *Tạo artwork*.
- **Product base**: 4 loại sản phẩm theo bảng giá Notion.
- **Thư viện**: Clipart (các bộ) + Font chữ. Khuôn in và phôi đã chuyển vào Product base.

### 5.2 Product base (quản lý giá, khuôn, phôi)

Mở tab Product base → bấm 1 base:

1. **Thông tin**: tên (loại sản phẩm), Shopify product type (*Acrylic Ornament* / *Christmas Ornament* — quyết định
   nhóm ship), chất liệu, xưởng + catalog ID, mô tả mặc định.
2. **Print areas**: khổ file xưởng nhận (px, dpi). Ceramic 2 mặt có Front + Back (hiện mặt sau in giống mặt trước).
3. **Biến thể + giá**: chọn bảng giá Notion; *Sửa bảng giá* để đổi giá (mọi sản phẩm dùng base này deploy lại là theo
   giá mới). Không tạo bảng giá mới cho từng sản phẩm.
4. **Khuôn in + phôi**: khuôn của loại sản phẩm; upload phôi / *Tạo phôi bằng AI*; *Quản lý khuôn* để tạo / sửa khuôn.
5. **Mockups**: tự gom từ mọi sản phẩm làm trên base này.

Hiện có:

| Product base | Khuôn | Giá (Notion) |
|---|---|---|
| Acrylic Ornament 1 side | Acrylic cắt viền (alpha) 100×100 mm | 4", 4.5", 5.5" × pack 1/2/3/4/5/10 — $19.95 → $139.50 |
| Glass Ornament 1 side | Kính tròn vát kim cương 76 mm | $23.95 (Circle; Heart chưa có khuôn) |
| Ceramic Ornament 2 sides | Sứ tròn 3" | $23.95 (Circle; Heart / Star chưa có khuôn) |
| Poseable Doll | chưa có khuôn (print area 4000×1944) | 8in / 10in / 12in — $29.96 → $39.71 |

### 5.3 Tạo artwork — 3 cách

1. **Tự động từ bộ clipart**: Thư viện → *Tạo bộ clipart mới* → làm bộ trong trang bộ (chat @flexiprint) → xong có
   artwork.
2. **Import bộ**: Artwork → *Import bộ clipart* (folder hoặc zip) → xong có artwork + clipart.
3. **Thủ công**: Artwork → *Tạo artwork* → đặt tên → chọn:
   - **một Product base** → canvas = khuôn in của loại đó (đường cắt, lỗ treo, phôi có sẵn), hoặc
   - **Canvas trống** → tự nhập rộng × cao px.

   Sau đó trong editor kéo bộ clipart (tab Thư viện bên trái) hoặc thêm chữ (T), ảnh khách (U).

### 5.4 Làm việc trong artwork (editor)

Editor artwork chỉ có 3 tab: **Thiết kế · Xem trước · File in**.

- **Thiết kế**: canvas phẳng. Cột trái = các version. Cột phải = Layers + thuộc tính.
  - Cột Layers có 3 nhóm xổ / gập như Teeinblue: **Preview (preview only)** (dòng cố định *Phôi trơn* — bấm để đặt
    phôi), **Print (Order only)** (dòng cố định *Khuôn in*), **Thiết kế (preview + file in)**. Kéo layer thả lên tiêu đề
    nhóm để chuyển nhóm, hoặc chọn layer → ô **Nhóm**. Thiếu phôi / khuôn → báo "thiếu".
  - Không chọn layer nào: cột phải hiện các option để xem thử từng lựa chọn.
- **Xem trước**: trang sản phẩm như khách thấy trên Shopify, thiết kế đặt trên phôi trơn (layer *chỉ file in* bị ẩn).
- **File in**: đúng file gửi xưởng (layer *chỉ preview* bị bỏ).
  - Mặc định hiện **cặp file cùng kích thước px**: trái = **thiết kế nằm trong khuôn** (đường hồng = đường cắt), phải =
    **silhouette khuôn full đen** (như "Print silhouette" của Teeinblue). Đặt trái chồng lên phải là ra sản phẩm.
  - Chế độ **print.png**: file in thật; bật **Silhouette** thì thành 1 file cao gấp đôi — nửa trên silhouette full
    đen, nửa dưới bản in (đúng khổ acrylic Merchize / Teeinblue).
  - **Tải gói file in** (zip): `print.png`, `thiet-ke-tren-khuon.png`, `silhouette-khuon.png`, `cut.svg` (khuôn có
    đường cắt vector), `print-khong-silhouette.png` (khi đang bật silhouette).
- **Lưu artwork** (⌘S). Lưu không làm đổi sản phẩm đã tạo — chúng hiện badge *Có bản artwork mới*.

**File in theo từng loại sản phẩm:**

| Loại | File in | Silhouette |
|---|---|---|
| Áo / quần / túi / thảm (in phẳng) | File thiết kế phẳng đúng khổ, preview đặt trên phôi | Không cần |
| Acrylic ornament (cắt theo hình) | Cắt theo alpha của thiết kế (+ lỗ treo) | Bật — full đen nửa trên |
| Ornament sứ / kính tròn | Cắt theo khuôn tròn (xưởng cung cấp hoặc khuôn của ta), giữ trống lỗ treo | Tuỳ xưởng; luôn có silhouette khuôn trong gói |

### 5.5 Tạo sản phẩm (= artwork + product base)

Hai chỗ bấm:

- Tab **Artwork** → nút túi xách trên thẻ, hoặc trong editor → *Sản phẩm từ artwork* → *Tạo sản phẩm*.
- Tab **Sản phẩm** → *Tạo sản phẩm* → chọn artwork → chọn product base.

Đặt tên theo chủ đề (mặc định = tên artwork) → *Tạo sản phẩm*. Sản phẩm giữ 1 bản chụp của artwork tại lúc tạo.

### 5.6 Trang sản phẩm

- **Header**: tên (sửa được), *Product base* (đổi được → giá + biến thể đổi theo), *Từ artwork …* (badge *Có bản
  artwork mới · Cập nhật* khi artwork đã sửa), **Deploy**.
- **Bên trái — Mockups**: phôi trơn + "phôi + thiết kế" làm ảnh tham khảo; *Tạo mockup* bằng AI theo từng dòng bối
  cảnh; **Import mockup** để đưa ảnh có sẵn (chụp thật, Photoshop) vào; xoá ảnh không dùng.
- **Bên phải — trang bán**: tiêu đề, **giá + size + pack** của product base, **form personalize** của artwork, thử
  chọn / nhập như khách.

### 5.7 Deploy

Bấm **Deploy** trên trang sản phẩm → trang Deploy: tiêu đề, mô tả (mặc định lấy từ base nếu chưa có), ảnh (mockup),
collection. **Bảng giá không chọn ở đây nữa** — lấy theo product base. Artwork không deploy được (phải tạo sản phẩm
trước).

### 5.8 Sửa artwork khi đã có sản phẩm

1. Sửa artwork → Lưu.
2. Sản phẩm dùng artwork đó hiện badge **Artwork mới** (tab Sản phẩm) / **Có bản artwork mới · Cập nhật** (trang sản
   phẩm). Sản phẩm vẫn giữ thiết kế cũ cho tới khi bấm cập nhật.
3. Cập nhật 1 cái (trên trang sản phẩm) hoặc nhiều cái (editor artwork → *Sản phẩm từ artwork* → chọn → *Cập nhật*).
4. Deploy lại để khách thấy.

---

## 6. Cho @flexiprint (agent, MCP flexi2)

- `char_add_product`, `create_artwork_product`, import build → tạo **artwork**.
- `list_base_products` → 4 product base (giá, khuôn, print area).
- `make_product_from_artwork {artwork_id, base_product_id, name?}` → sản phẩm.
- `make_product_mockups`, `check_deploy`, `deploy_product` chạy trên **id sản phẩm**, không phải id artwork.

---

## 7. Dữ liệu đã chuyển (2026-11-07)

- 7 sản phẩm đã có trên Shopify được tách: dòng cũ thành **sản phẩm** (giữ link Shopify, mockup), thêm 1 **artwork**
  mang thiết kế + nối với bộ clipart. 25 dòng còn lại thành artwork.
- Khuôn in chỉ giữ 3 khuôn của các base (acrylic, kính, sứ); artwork đang dùng khuôn cũ vẫn giữ bản sao khuôn riêng.
- Sao lưu trước khi chuyển: `/opt/flexi2/backups/2026-11-07-before-base-products.sql.gz` trên an-vm.

## 8. Còn thiếu

- Khuôn cho Glass Heart, Ceramic Heart / Star, khuôn + phôi cho Poseable Doll.
- Ceramic 2 mặt: mặt sau đang in cùng artwork mặt trước (chưa có artwork riêng cho từng mặt như Teeinblue).
- Một số artwork cũ chưa có ảnh trên thẻ: mở và bấm *Lưu artwork* một lần.
