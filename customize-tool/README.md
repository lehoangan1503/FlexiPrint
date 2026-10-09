# Customize Tool (2D)

Tool dựng sản phẩm custom 2D kiểu Customily / Teeinblue: **main object** + các **vùng custom** + **sub object** có nhiều **version**. Clipart (ảnh bất kỳ) upload tay vào danh mục, mỗi danh mục có 2 tab Clipart / Artwork; mỗi version của sản phẩm được lưu thành 1 artwork trong danh mục mang tên sản phẩm. Thiết kế và File in phẳng (file in = toàn khung edit, cắt theo khuôn); Xem trước và **Mockups** đặt artwork lên phôi trơn (upload hoặc AI vẽ theo khuôn in), mockup bối cảnh do AI tạo.

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
   CT_BG_REMOVER_URL=http://127.0.0.1:7001  # microservice tự host services/bg-remover (rembg + BiRefNet) — miễn phí, khuyên dùng
   CT_MATERIAL_URL=http://127.0.0.1:7003    # services/material-render — file in + đường cắt laser (nút "Xuất file in" trong dialog Vật liệu & file in)
   # CT_BG_REMOVER_TOKEN=...     # nếu service đặt BG_TOKEN
   # FAL_KEY=...                 # cùng BiRefNet nhưng host bởi fal.ai (trả tiền theo lượt)
   # CT_CUTOUT_MODEL=General Use (Heavy)
   # CT_PHOTO_AI_PROVIDER=gemini # provider cho style AI (mặc định: gemini, rồi openai)
   # CT_PHOTO_AI_MODEL=...
   ```
   **Model tạo ảnh AI (trang Home)**: ô chọn cạnh "Tạo sản phẩm custom" — áp cho cả team (`ct_settings`, chạy
   `migrations/020_settings.sql`): mọi ảnh AI của bộ nhân vật v2 (cả của @flexiprint) dùng model này; hỏng / hết
   credit thì tự thử model kế. Mặc định
   `cpa:gpt-image-2.5` (API ảnh công ty, `CPA_API_KEY`); Nano Banana 2 / Nano Banana chạy trên fal (`FAL_KEY`).
   Danh sách: `lib/image-models.ts`. Style ảnh khách (AI tạo ảnh bên dưới) vẫn dùng model riêng của từng style.

   Style ảnh khách có 2 tab trong inspector:
   - **Free**: Real photo · Pixel art (lọc trên trình duyệt).
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
  - `material: { id, shape, widthMm, borderMm, thicknessMm, display }` — phôi vật lý + storefront hiện art phẳng hay rendition AI (`lib/materials.ts`)
- **Thư viện clipart** (migration 006, `server/library.ts`, trang `/library`, tab *Thư viện* trong editor):
  - `ct_assets.product_id NULL` = clipart dùng chung.
  - Danh mục `ct_clipart_categories`:
    - `usage` main/element
    - `mode` origin_set/variant_set
    - `spec` + `rules`: canvas, fill, anchor, nền, `lockSilhouette`, trục biến thể, style pack
  - `ct_product_mains`: main version lấy từ thư viện.
  - `ct_presets`: vật liệu (đặt tên cho bản vật liệu, luật dây treo cho mockup); style pack / scene cũ còn trong bảng.
  - Role `rendition` = bản vật liệu (upload tay: “Upload vật liệu” trên clipart gốc ở `/library`).
  - Clipart đang được sản phẩm dùng thì không xoá được.
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
   - **Custom layer** (tool L): thiết kế cố định của mình, **không phải option của khách** — store vẽ đúng ảnh đang chọn
     trong editor (`template.picks`), không hiện picker, không vào giỏ. Giống image frame: L (hoặc bấm vào 1 custom
     layer trống) mở **thư viện ảnh mockup** (tải ảnh mới / chọn ảnh) → ảnh thành layer; kéo clipart từ tab
     Thư viện vẫn như cũ. Inspector → "Đổi ảnh…".
   - Text / Ảnh khách = **option của khách**. Mỗi vùng có thể có **option con** (như "Thêm option" của version):
     khách chọn thêm 1 hàng (Choose color: Gold / Silver…). Option con của text đổi chữ (font, cỡ, màu, viền, uốn
     cong); của ảnh khách đổi hình khung. Bấm 1 option con trong inspector để xem — lúc đó sửa chữ / kéo khung trên
     canvas là sửa option đó (`zoneOptionView`, `CtRegionConfig.options`).
   - (Cũ) Object: mình định nghĩa option. Vùng có 1+ **nhóm**; nhóm = 1 sub object + các version của nó,
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
   Tab **Mockups**: dựng mockup tay (nền, image frame, version, chữ) → **Lưu mockup**; cần bản vật liệu của mọi clipart trong khung.

7. **Deploy sản phẩm** (header) → trang `/products/:id/deploy`: chọn / tạo **bảng giá**, tên + mô tả + ảnh, rồi 1 nút
   deploy thẳng lên Shopify (template + sản phẩm + variants có giá). Xem mục Shopify bên dưới.

Phím tắt (hover nút để thấy): V · H/Space · R · O · P · Enter · Esc · ⌘Z/⇧⌘Z · ⌘S · ⌘D · Delete · mũi tên (Shift = 10px).
Với polygon: double-click cạnh để thêm điểm, Alt+click đỉnh để xoá điểm.

## Khuôn in, artwork, mockup theo option (migration 024)

Khuôn in (`/templates`, bảng `ct_print_templates`, `types/print.ts`, `lib/print-template.ts`) = phôi, không phải thiết kế:
cỡ file in (px / mm / dpi), đường cắt, tràn lề, **safe zone**, phần cắt bỏ (lỗ treo), **vùng có tên** (ống quần, cạp…),
**cỡ** (S…4XL, mỗi cỡ một tờ; vùng co giãn theo tờ). Ba loại: `flat` (ornament, tile, poster), `cut` (cắt theo viền
artwork), `panels` (quần áo in toàn thân). Mẫu có sẵn được thêm lần đầu mở trang.

- **Tạo sản phẩm từ khuôn** (`server/print-products.ts`): canvas = tờ in trong suốt, đường cắt + lỗ = khuôn vật liệu
  (file in cắt theo nó), `config.print` = bản sao khuôn. Editor vẽ safe zone / vùng chồng lên, báo layer ngoài safe zone.
- **Layer phủ vùng** (`config.fill`): một ảnh phủ kín (nền) hoặc hoa văn lặp (`tile` px) trong một vùng của khuôn; mỗi
  cỡ vẽ vào vùng của cỡ đó (`lib/compositor.ts` `size`). **Chỉ in** (`config.printOnly`): có trong file in, không vẽ lên ảnh
  mockup (nền mà ảnh sản phẩm đã có sẵn).
- **Mockups tab**: ảnh mockup theo từng lựa chọn của layer chỉ in (`config.mockupsByOption` — storefront đổi ảnh khi khách
  đổi nền, đặt phần còn lại của thiết kế lên ô) và **mockup tô vùng** cho quần áo (`config.zoneMockups`, `lib/zone-mockup.ts`:
  tô hoa văn khách chọn vào từng vùng trên ảnh + nhân lại nếp vải, không uốn file in).
- **Add to cart**: storefront dựng file in đủ cỡ (đúng cỡ khách chọn trên Shopify nếu khuôn có cỡ) → `_ct_print`.
- **File in tab**: chọn cỡ; "Lưu artwork vào thư viện" = clipart gốc tag `artwork` (meta.artwork: product, lựa chọn).
- **MCP** (`server/mcp/print-tools.ts`): `list_print_templates`, `get_print_template`, `create_artwork_product`,
  `set_artwork_layers`, `check_artwork`, `render_artwork` (ảnh server-side bằng sharp để agent tự xem) — agent xếp clipart
  thư viện theo toạ độ tờ in, không vẽ ảnh AI.
- **v2**: brief chọn khuôn in → câu bố cục (`layoutHint`) vào prompt master; sản phẩm của bộ nhân vật dựng trên khuôn,
  nhân vật + chữ nằm trong safe zone.

## Vật liệu (acrylic, sứ, nhôm, gỗ)

Vật liệu tách làm 2 phần:

1. **Phôi vật lý**: dialog *Vật liệu & file in* (`print-dialog.tsx`, `config.material`) gồm loại phôi, viền cắt
   (`contour` = theo hình + `borderMm`, `main` = phôi là main object), `widthMm`, `thicknessMm`. Phần này chỉ
   dùng cho file in.
2. **Bề ngoài vật liệu**: ảnh **rendition** upload tay cho từng clipart (`/library` → “Upload vật liệu”, chọn preset
   `material` để đặt tên + phiên bản như “có dây”), **không mô phỏng bằng canvas**.
   - Rendition nên cùng kích thước / vị trí với clipart gốc để thay vào đúng chỗ.
   - `config.material.display = "rendition"`: template publish vẽ rendition thay cho clipart phẳng
     (`lib/library.ts withRenditions`). Clipart chưa có rendition thì vẫn hiện bản phẳng.
   - File in luôn dùng art phẳng.

**Xuất file in (.zip)**:
- Đầu vào: tổ hợp đang chọn (art phẳng) → `services/material-render` (`CT_MATERIAL_URL`).
- Kết quả gồm:
  - `print.png` (dpi thật)
  - `white.png` (lớp mực trắng cho acrylic)
  - `cut.svg` (mm)
  - `preview.png`
  - `meta.json`

Chi tiết đường cắt:
- **contour**: alpha → nở `borderMm` → lấp lỗ → closing.
- **main**: alpha của main version.

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

Theme: `scripts/push-theme.sh` (Shopify CLI, staff login) đẩy section thành `sections/flexiprint-product.liquid`
+ 2 asset + `templates/product.json` / `product.flexiprint.json` (api_base = APP_URL) lên theme FlexiPrint.

### Deploy sản phẩm (`components/deploy/`, `server/shopify.ts`)

Env: `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` (app Dev Dashboard, client credentials →
token 24h), `SHOPIFY_API_VERSION`. Scope dùng: `write_products`. Muốn tự bật kênh Online Store cần thêm
`read_publications` + `write_publications` (thiếu thì deploy báo cảnh báo).

1. **Bảng giá** (`ct_price_tables`, migration 018, `lib/pricing.ts`): đặt tên, mọi người dùng chung, chọn từ list.
   Size (giá 1 cái, giá gạch) × Pack (số cái, nhãn "2 PCS", % giảm); mỗi ô = 1 variant Shopify, giá = **tổng của
   pack**, gõ tay được từng ô. Chỉ 1 size không tên / chỉ 1 pack 1 cái = bỏ option đó.
2. Nút Deploy: lưu thiết kế → publish template mới (`ct_templates`) → 1 `productSet` (synchronous): title, mô tả,
   status, vendor, type, tags, template suffix `flexiprint`, options + variants (inventory không track, CONTINUE),
   ảnh = tổ hợp / mockup đã chọn (ảnh cũ dùng lại theo id), metafield:
   - `customize_tool.product_id` = id sản phẩm FlexiPrint
   - `customize_tool.pricing` (json `CtShopifyPricing`): option nào là pack + mỗi giá trị bao nhiêu thiết kế
   Deploy lại = cập nhật đúng sản phẩm đó (`ct_products.shopify`), variant khớp theo option values nên id giữ nguyên.
   "Chọn sản phẩm có sẵn" để deploy lên 1 sản phẩm Shopify đã có (thay options/variants theo bảng giá).
3. Trang deploy liệt kê option khách sẽ thấy theo từng version (`lib/option-audit.ts`) và cảnh báo trước:
   trường chưa có nhãn, 2 trường trùng nhãn, custom layer trống…

### main-product.liquid — dynamic

- Mọi option Shopify của sản phẩm đều render (bao nhiêu option, tên gì cũng được). Option trùng
  `pricing.packOption` hiện thành thẻ "N PCS · $x/pc" (giá 1 cái theo size đang chọn, tính từ giá variant).
- Pack N cái (Different Designs) = **N thiết kế độc lập**: form có tab "<item> 1…N" (tên từ bảng giá, vd. Ornament),
  canvas có "Ornament k/N ‹ ›". Thiếu trường ở thiết kế nào thì mở đúng thiết kế đó.
- Sản phẩm không có metafield pricing = như cũ (1 thiết kế). Không có `customize_tool.product_id` = trang sản phẩm thường.

Add to cart: kiểm tra trường bắt buộc (mọi thiết kế), render + upload preview từng thiết kế, thêm line item
properties rồi submit lại form để theme xử lý giỏ như bình thường. 1 thiết kế:

```
properties[Choose Color]      = Red                    (tên option — khách thấy)
properties[Enter name]        = Mochi
properties[Choose style]      = Gold                   (option con của vùng)
properties[Upload your photo] = https://…/customize-tool-orders/…/photo-….jpg
properties[_ct_preview]       = https://…/preview-….png   (ẩn: bắt đầu bằng _)
properties[_ct_template]      = <product id>@v<version>
properties[_ct_selection]     = JSON selection đầy đủ (dựng lại đúng bản khách thấy)
```

Pack N thiết kế: mỗi trường có tiền tố `Ornament k · ` (`properties[Ornament 2 · Enter name]`), preview
`_ct_preview`, `_ct_preview_2` … `_ct_preview_N`, `_ct_designs` = N, `_ct_selections` = JSON mảng N selection.

Endpoint public (không cần đăng nhập, CORS `*`):
`GET /api/customize-tool/public/templates/:id[?version=N]` · `POST /api/customize-tool/public/uploads/:id`.
Upload chỉ nhận sản phẩm đã publish, ảnh PNG/JPEG/WebP ≤ 15MB; chưa có rate limit.

## Chưa làm (bước sau)

- Rate limit / dọn rác cho upload public (ảnh khách của giỏ bị bỏ dở; cache ảnh đã có TTL 24h).
- Tự xuất file in khi có đơn (webhook Shopify → `_ct_selection` → render → material-render). Hiện: nút trong editor.
- Chạy generation dạng job nền (hiện là request đồng bộ, tối đa ~120s).

## AI là plugin

Phần dựng sản phẩm v1 chạy thuần upload. AI còn lại: style AI cho ảnh khách (`FAL_KEY`), tách nền dự phòng
(`GEMINI_API_KEY` / `OPENAI_API_KEY`), content Shopify và bộ nhân vật v2 (@flexiprint, model ảnh của team).

Phần AI phía server nằm ở `server/ai/` (`photo.ts`, `fal-style.ts`, `providers.ts`) và `server/pack-images.ts` (`drawImage`, dùng cho v2).
