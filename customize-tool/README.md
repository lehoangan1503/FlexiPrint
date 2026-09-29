# Customize Tool (2D)

Tool dựng sản phẩm custom 2D kiểu Customily / Teeinblue: **main object** + các **vùng custom** + **sub object** có nhiều **version**. Có tạo asset bằng AI, xuất tổ hợp và tạo mockup AI (nhiều sản phẩm trong 1 ảnh).

Toàn bộ code nằm trong folder này. Host site chỉ có 3 file shim 1 dòng và 1 tab trên dashboard.

## Cấu trúc

```
customize-tool/
  config.ts              ← mọi thứ gắn với host: route, bucket, schema, fonts
  types/                 ← domain types (CtProduct, CtAsset, CtRegion, …)
  migrations/            ← SQL (chạy tay trên Supabase)
  lib/                   ← dùng chung client/server
    geometry.ts            hình học vùng (rect / ellipse / polygon)
    design.ts              mặc định, lựa chọn, tổ hợp
    compositor.ts          render canvas: preview = export = storefront sau này
    image-tools.ts         xoá nền (flood-fill từ viền) + trim
    photo-styles.ts        danh mục style ảnh khách (dùng chung editor/storefront/server)
    photo-process.ts       ảnh khách → ảnh render: gọi server, key nền, trim, filter pixel
    api-client.ts          fetch có type
    template.ts            dựng template publish (JSON cho storefront) — dùng cho Publish và tab Xem trước
  server/                ← chỉ chạy trên server
    router.ts              1 catch-all dispatcher cho cả API
    handlers.ts            products / assets / design / generate
    ai/providers.ts        Gemini (Nano Banana) + OpenAI (gpt-image)
    ai/prompts.ts          khung prompt theo role
    ai/photo.ts            style AI + tách chủ thể cho ảnh khách (fal BiRefNet / AI fallback)
    supabase.ts, storage.ts, image-size.ts, png-alpha.ts (PNG có nền trong suốt thật không)
    blob-store.ts          interface lưu file (driver supabase; R2 thêm driver ở đây)
    photo-cache.ts         cache kết quả ảnh khách (AI style, tách nền) — RAM + Storage 24h

  components/            ← UI (không import "@/…"); ui.tsx = shadcn copy (Radix)
    product-list.tsx       grid (trang index + tab dashboard)
    editor/                editor: stage, inspector, asset panel, dialogs, publish
  routes/index.tsx       ← page components mà shim của host re-export
  storefront/customizer.ts ← customizer của main-product.liquid (không side effect): theme + tab Xem trước dùng chung
  storefront/index.ts    ← entry Shopify: boot mọi section (bundle → ct-customizer.js)
  scripts/build-storefront.mjs → shopify/assets/ct-customizer.js
  shopify/               ← file theme: sections/main-product.liquid, assets/, templates/
```

Shim trên host (khi tách site thì tạo lại y hệt):

```
src/app/customize-tool/page.tsx               export { CustomizeListPage as default } from ".../customize-tool/routes"
src/app/customize-tool/[id]/page.tsx          export { CustomizeEditorPage as default } from ".../customize-tool/routes"
src/app/api/customize-tool/[...path]/route.ts export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = ctRouteHandlers
```

Tab dashboard: `src/app/dashboard/dashboard-client.tsx` → `view === "customize"`.

## Cài đặt

1. Chạy `migrations/001_customize_tool.sql`, `002_customize_tool_publish.sql`, `003_ai_photo_styles.sql` rồi `004_service_role_grants.sql` trên Supabase (schema `shopify_customizer`).
   Thiếu 002 thì Lưu thiết kế / Publish báo lỗi "Thiếu migration". Thiếu 004 thì endpoint public của storefront
   báo "permission denied for table ct_templates" → trang sản phẩm không có form custom.
2. Thêm env (ít nhất 1 provider):
   ```
   GEMINI_API_KEY=...            # Nano Banana 2 / Pro
   OPENAI_API_KEY=...            # gpt-image (có nền trong suốt)
   # OPENAI_BASE_URL=...         # proxy tương thích OpenAI (tuỳ chọn)
   # GEMINI_IMAGE_MODELS=gemini-3.1-flash-image-preview,gemini-3-pro-image-preview
   # OPENAI_IMAGE_MODELS=gpt-image-1.5
   ```
   Key YEScale hiện tại không có model ảnh nên không dùng được cho phần này.
   Ảnh khách (vùng "Ảnh khách" → Xử lý ảnh khách):
   ```
   CT_PHOTO_STYLE_URL=http://127.0.0.1:7002 # microservice services/photo-style — style vẽ bằng OpenCV, không AI, ~1 giây
   CT_BG_REMOVER_URL=http://127.0.0.1:7001  # microservice tự host services/bg-remover (rembg + BiRefNet) — miễn phí, khuyên dùng
   CT_MATERIAL_URL=http://127.0.0.1:7003    # services/material-render — file in + đường cắt laser (nút "Xuất file in" trong dialog Vật liệu)
   # CT_BG_REMOVER_TOKEN=...     # nếu service đặt BG_TOKEN
   # FAL_KEY=...                 # cùng BiRefNet nhưng host bởi fal.ai (trả tiền theo lượt)
   # CT_CUTOUT_MODEL=General Use (Heavy)
   # CT_PHOTO_AI_PROVIDER=gemini # provider cho style AI (mặc định: gemini, rồi openai)
   # CT_PHOTO_AI_MODEL=...
   ```
   Style ảnh khách có 2 tab trong inspector:
   - **Free**: Real photo · Oil painting (service photo-style) · Pixel art (lọc trên trình duyệt).
   - **AI tạo ảnh**: thư viện style chung `ct_ai_styles` (chạy `migrations/003_ai_photo_styles.sql`), mỗi style = prompt + model fal.ai + params, chạy bằng `FAL_KEY`.
     Mặc định `fal-ai/nano-banana/edit` (Gemini 2.5, $0.039/lượt, giống store đối thủ; lỗi/bị Google tắt thì server tự chạy lại bằng `fal-ai/nano-banana-2/edit` $0.08). Ai cũng xem/tạo; chỉ người tạo sửa/xoá style của mình; admin / superadmin sửa được tất cả.
     Vùng ảnh lưu style dạng `ai:<uuid>`; template publish chỉ chứa tên style — prompt/model không bao giờ ra storefront.
     Chống spam endpoint public: client chỉ gửi ảnh + region + ref; giới hạn/ngày theo IP (`CT_AI_IP_DAILY_LIMIT`, mặc định 12) và tổng (`CT_AI_DAILY_LIMIT`, mặc định 300) lưu trong Postgres; cache kết quả; `CT_ALLOWED_ORIGINS` tuỳ chọn.
   Không có bg-remover / FAL_KEY thì tách nền nhờ AI provider vẽ lại chủ thể trên nền trắng rồi trình duyệt key nền — ổn cho style vẽ, nhưng "Real photo" sẽ bị vẽ lại nhẹ.
   Endpoint public `public/photo/:id` chỉ nhận style/cut-out mà vùng đã bật trong bản publish mới nhất, có rate-limit đơn giản theo IP (30 lượt/10 phút/instance) + giới hạn/ngày cho style AI (ở trên).
3. Storage dùng bucket `product-assets` sẵn có, đường dẫn `<uid>/customize-tool/<product>/<role>/…`.
   Upload từ storefront (ảnh khách, preview giỏ hàng) nằm ở `customize-tool-orders/<product>/<ngày>/…` — giữ lại vì đơn hàng cần.
   Cache ảnh đã xử lý: `customize-tool-cache/photo/<sha256>.png`, xoá 24h sau khi upload (`CT_CACHE_TTL_HOURS`).
   Cùng ảnh + cùng style (+ cùng phiên bản style) = trả từ cache, không gọi AI / không tính quota lại.
   Cron mỗi giờ: `scripts/cleanup-cache.sh` → `POST /api/customize-tool/cron/cleanup` với `Authorization: Bearer $CT_CRON_SECRET`
   (hướng dẫn cài trong file). Không có cron thì app tự dọn tối đa 1 lần/giờ khi ghi cache mới.
   Chuyển sang R2: viết driver trong `server/blob-store.ts` (`CT_STORAGE_DRIVER`), rồi dùng lifecycle rule của R2 cho prefix cache.
4. `SUPABASE_SERVICE_ROLE_KEY` (host đã có) — bắt buộc cho 2 endpoint public của storefront. Không có key thì chúng trả 501.

## Mô hình dữ liệu

```
ct_products ─┬─ main_asset_id ──► ct_assets(main)
             ├─ ct_assets  role: main | sub | variant | composite | mockup | reference
             │    ├─ parent_id ─► ct_assets      (variant → sub)
             │    └─ generation_id ─► ct_generations
             ├─ ct_regions (vùng custom; shape jsonb theo pixel của main)
             │    └─ ct_region_items ─► ct_assets(sub)  + transform
             └─ ct_generations (prompt, refs, model, status: log mọi request AI)
```

- `ct_products.config` (002): option cấp sản phẩm (jsonb, không cần migration mới):
  - `main: { enabled, label, display }` — version main cho khách chọn
  - `layouts: { [mainAssetId]: { regions: { [regionId]: { shape?, hidden? } }, items: { [itemId]: transform } } }` —
    bố cục riêng của từng version main (`lib/layout.ts`)
  - `material: { id, shape, widthMm, borderMm, thicknessMm, shadow, gloss, sceneAssetId, scene }` — vật liệu render (`lib/materials.ts`)
- `ct_templates` (002): snapshot bất biến theo version, ghi bởi **Publish**; storefront đọc bản mới nhất.
- Xoá product thì cascade toàn bộ. File trên Storage được API xoá trước.
- Lưu thiết kế đi qua RPC `ct_save_design`, 1 transaction.
- Xoá nền thay file **tại chỗ** (`PUT assets/:id/file`), id giữ nguyên nên FK không gãy.

## Quy trình

1. **Main object**: upload hoặc AI (1 request). Ảnh main đầu tiên tự thành main (vương miện = mặc định).
   **Version của main**: bật "Khách chọn version main" ở tab Main → mọi ảnh main là 1 option
   (vd. Choose Color: đen / xám / đỏ, mỗi màu 1 ảnh sản phẩm). Tên ảnh = tên option; hiển thị
   tile / swatch (màu chọn trên từng ảnh) / nút chữ / dropdown. Version nên cùng kích thước với
   main mặc định (vùng tính theo pixel của nó; lệch sẽ bị kéo giãn — có cảnh báo trên card).
   **Vị trí riêng theo version** (checkbox "Vị trí riêng" trên card version, cần bật "Khách chọn version"):
   version đó có bố cục vùng của riêng nó — vd. `1 người` / `2 người` / `3 người` là 3 version main, mỗi
   version xếp các vùng ảnh khách theo kiểu riêng và **ẩn** vùng không dùng (inspector → "Ẩn vùng này ở version
   này"; storefront bỏ luôn ô upload đó, không bắt buộc). Hoặc xe + mũ bảo hiểm là 1 ảnh main, mỗi xe 1 version,
   khung ảnh khách (polygon chấm quanh lỗ mũ, clip bật) nằm đúng chỗ mũ của từng xe.
   Chọn version (click card) → canvas có nhãn tím "Đang sửa vị trí riêng…": kéo / resize vùng, object trong
   vùng chỉ đổi cho version đó; tên, nội dung, style… vẫn dùng chung. Vùng không sửa thì theo main mặc định.
   Main mặc định luôn là bố cục gốc.
2. **Vùng custom**: vẽ bằng R (rect), O (ellipse), P (polygon, chấm điểm). Loại vùng:
   - Object: mình định nghĩa option. Vùng có 1+ **nhóm**; nhóm = 1 sub object + các version của nó,
     mỗi ảnh là 1 option, cả nhóm dùng chung vị trí/scale. Trong inspector bấm **Thêm nhóm —
     upload nhiều ảnh** (ảnh đầu = sub, còn lại = version) hoặc ô "+" để thêm option vào nhóm.
     Có 2+ nhóm thì khách chọn nhóm trước (Choose Style: Glitter / No Glitter), đổi nhóm giữ
     đúng vị trí option (xanh glitter → xanh no-glitter). Ẩn option bằng icon mắt.
   - Text: khách nhập chữ, có font, viền, uốn cong. Điền "Lựa chọn có sẵn" (mỗi dòng 1) để khách
     chọn từ dropdown (Choose Quote / Choose State).
   - Ảnh khách: khách upload ảnh. Luôn tách chủ thể + làm mờ phần bị khung cắt (không còn tuỳ chọn).
     Ảnh gốc không bao giờ được vẽ vào khung — chỉ hiện loading cho tới khi có ảnh đã xử lý.
     Model AI trả được nền trong suốt (GPT Image) thì bỏ qua bg-remover.
     Inspector có nút **Upload ảnh test** để thử kết quả cuối ngay trên canvas.
   Tuỳ chọn chung: **Cắt theo hình vùng** (ẩn phần tràn ra ngoài viền vùng) và **Thứ tự lớp so với
   main** (trên main, hoặc dưới main — chỉ lộ qua phần trong suốt của main, vd. ảnh sau ô cửa sổ khung).
   Double-click tên layer để đổi tên. Thứ tự Layers (trên cùng trước) = thứ tự form cho khách.
3. **Sub object**: upload hoặc AI (1 request). Sau đó **Version AI**: mỗi version là 1 request, sub gốc là ảnh tham chiếu đầu tiên để giữ khung hình.
4. **Xoá nền / trim** cho output AI (Gemini không có alpha).
5. **Đặt vào vùng**, rồi vào Chế độ Object (Enter hoặc double-click) để kéo, scale, xoay object trong vùng.
6. Tab **Xem trước**: đúng trang sản phẩm khách thấy trên Shopify — markup của `main-product.liquid`, CSS của theme và
   cùng class `Customizer` với storefront, chạy trên bản thiết kế hiện tại (kể cả chưa lưu). Vùng / option mới hiện ngay,
   không reset lựa chọn đang thử. Không sửa gì ở đây. Add to cart hiện danh sách line-item properties sẽ vào giỏ (không upload).
   Tab **Tổ hợp & Mockup**: **Lưu tổ hợp** (1 / N random / N tổ hợp). Chọn nhiều tổ hợp rồi bấm **Tạo mockup AI**. Ảnh tổ hợp đi thẳng vào AI, không cần tải về.

7. **Publish** (header) → Shopify. Xem mục bên dưới.

Phím tắt (hover nút để thấy): V · H/Space · R · O · P · Enter · Esc · ⌘Z/⇧⌘Z · ⌘S · ⌘D · Delete · mũi tên (Shift = 10px).
Với polygon: double-click cạnh để thêm điểm, Alt+click đỉnh để xoá điểm.

## Vật liệu (acrylic, sứ, nhôm, gỗ)

Nút **Vật liệu** trên header. Asset không cần có sẵn viền trắng / hiệu ứng: thiết kế phẳng (main + mọi layer)
được render thành sản phẩm thật **sau** khi ghép, nên đổi xe / đổi chữ là viền đi theo.

| Vật liệu | Viền plate mặc định | Ghi chú |
|---|---|---|
| Acrylic trắng | cắt theo hình + viền | kẹp xe, standee: viền trắng bao cả xe + chữ, cạnh dày 3mm, bóng đổ |
| Acrylic trong | cắt theo hình + viền | viền plate trong suốt (thấy nền), cạnh ánh xanh |
| Sứ bóng / Sứ mờ | theo phôi = main | main = phôi trắng (ornament tròn + dây), mọi layer in lên phôi và bị cắt theo phôi; men bóng |
| Nhôm | theo phôi = main | ánh kim dạng dải |
| Gỗ | cắt theo hình + viền | vân gỗ + mặt gỗ ngả màu |

- **Cắt theo hình** (`contour`): alpha thiết kế → nở ra `borderMm` (distance transform) → lấp lỗ → closing để khe
  giữa các chữ thành 1 đường cong mượt. Đây cũng là đường cắt laser.
- **Theo phôi** (`main`): alpha của main version là plate.
- `widthMm` = bề rộng thật của main (vd. 5.5 in = 139.7 mm) → đổi mm ra pixel; dialog cảnh báo nếu main < 200 dpi.
- **Ảnh nền**: sản phẩm được đặt lên 1 ảnh (tab Tham chiếu) — vị trí / cỡ / xoay; storefront hiện đúng ảnh này.
- Preview chạy trên trình duyệt (`lib/material-render.ts`, 30–100 ms) — editor (checkbox "Xem vật liệu" trên canvas,
  tab Tổ hợp), storefront canvas và ảnh preview trong giỏ. Tổ hợp lưu (input AI mockup) vẫn là thiết kế phẳng.
- **Xuất file in (.zip)**: tổ hợp đang chọn → `services/material-render` (`CT_MATERIAL_URL`) →
  `print.png` (dpi thật) · `white.png` (lớp mực trắng cho acrylic) · `cut.svg` (mm) · `preview.png` ·
  `meta.json` (kích thước, diện tích, chiều dài đường cắt, cảnh báo plate bị tách nhiều mảnh / ảnh bị phóng to).
- Thêm vật liệu = thêm 1 entry trong `lib/materials.ts` (service nhận các núm render qua `preset`, không có danh mục riêng).

## Tách ra site riêng

1. Copy folder này sang app Next.js mới (cần `@supabase/ssr`, `@supabase/supabase-js`, `@radix-ui/react-dialog`, `-select`, `-checkbox`, `-tooltip`, `tailwind-merge`, `lucide-react`, `esbuild` (build storefront) và Tailwind có các token `background` / `foreground` / `border` / `input` / `muted` / `accent` / `popover` …).
2. Tạo lại 3 shim ở trên, sửa `config.ts` (basePath, loginPath, homePath, bucket).
3. Cùng env Supabase thì dùng được luôn dữ liệu cũ.

## Shopify

```
customize-tool/shopify/
  sections/main-product.liquid   section sản phẩm (gallery, variant, form, personalization)
  assets/ct-customizer.js        build từ storefront/index.ts — npm run build:ct-storefront
  assets/ct-customizer.css
  templates/product.customize.json
```

1. Upload 3 file section/assets lên theme (**không** full-push theme live). `main-product.liquid`
   sẽ THAY section cùng tên của theme; muốn giữ bản cũ thì đổi tên file thành `ct-main-product.liquid`
   và sửa `"type"` trong `product.customize.json` rồi gán template đó cho các sản phẩm custom.
2. Section setting **Customize Tool URL** = origin của app (vd. `https://tool.example.com`).
3. Mỗi sản phẩm: metafield `customize_tool.product_id` (Single line text) = id trong dialog Publish.
   Sản phẩm không có metafield hiển thị như trang sản phẩm thường.
4. Mỗi lần **Publish** tạo version mới; storefront lấy bản mới nhất (cache ~30s) — không phải sửa gì trên Shopify.

Trên storefront: bên trái là mockup (media sản phẩm); khách đổi option đầu tiên thì chuyển sang canvas
custom (nút "View product photos" để quay lại). Ảnh khách mở dialog: upload → kéo / zoom / xoay → Apply
(upload chạy ngay khi Apply). Add to cart: kiểm tra trường bắt buộc, render + upload preview, thêm
line item properties rồi submit lại form để theme xử lý giỏ như bình thường:

```
properties[Choose Color]      = Red                    (tên option — khách thấy)
properties[Choose Style]      = NO GLITTER
properties[Choose Dumpling]   = Blue
properties[Enter name]        = Mochi
properties[Upload your photo] = https://…/customize-tool-orders/…/photo-….jpg
properties[_ct_preview]       = https://…/preview-….png   (ẩn: bắt đầu bằng _)
properties[_ct_template]      = <product id>@v<version>
properties[_ct_selection]     = JSON selection đầy đủ (dựng lại đúng bản khách thấy)
```

Endpoint public (không cần đăng nhập, CORS `*`):
`GET /api/customize-tool/public/templates/:id[?version=N]` · `POST /api/customize-tool/public/uploads/:id`.
Upload chỉ nhận sản phẩm đã publish, ảnh PNG/JPEG/WebP ≤ 15MB; chưa có rate limit.

## Chưa làm (bước sau)

- Tự set metafield `customize_tool.product_id` khi deploy sản phẩm qua pipeline Shopify của host.
- Version main bằng ComfyUI (hiện: upload hoặc AI).
- Rate limit / dọn rác cho upload public (ảnh khách của giỏ bị bỏ dở; cache ảnh đã có TTL 24h).
- Tự xuất file in khi có đơn (webhook Shopify → `_ct_selection` → render → material-render). Hiện: nút trong editor.
- Chạy generation dạng job nền (hiện là request đồng bộ, tối đa ~120s).

## AI là plugin

Không có `GEMINI_API_KEY` / `OPENAI_API_KEY` thì tool chạy thuần upload, mọi nút AI (Tạo bằng AI, Version AI, Tạo mockup AI, tab Tham chiếu) tự ẩn. Thêm key rồi restart là bật.

Toàn bộ phần AI nằm ở `server/ai/` và `components/editor/generate-dialog.tsx`. Thêm provider mới = thêm 1 object vào `PROVIDERS` trong `server/ai/providers.ts`.
