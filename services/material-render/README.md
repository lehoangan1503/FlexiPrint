# material-render

Microservice cho sản phẩm in có **vật liệu**: acrylic (trắng / trong), sứ, nhôm, gỗ. Không AI — OpenCV + numpy.
Dùng bởi Customize Tool (`customize-tool/server/handlers.ts` → `printPack`) qua env `CT_MATERIAL_URL`.

Preview trên web **không** gọi service này: trình duyệt tự render (`customize-tool/lib/material-render.ts`, ~20–60 ms)
để đổi option là thấy ngay. Service làm phần cần độ phân giải thật: **file in + đường cắt**.

## Viền plate (shape `contour`)

Giống hệt bản trình duyệt:
1. alpha của thiết kế phẳng (≥ 40) → khoảng cách tới pixel thiết kế gần nhất (distance transform)
2. plate = khoảng cách ≤ `borderMm` + s → lấp lỗ bên trong (flood fill từ mép)
3. co lại s (closing) → khe giữa các chữ thành 1 đường cong mượt, cắt laser được
4. `findContours` + `approxPolyDP` (0.05 mm) → `cut.svg` theo **mm**

Shape `main`: alpha của main asset (phôi sứ tròn) là plate; mọi layer in lên phôi và bị cắt theo nó.

## API

```
POST /print-pack  multipart: file (thiết kế phẳng PNG, nền trong, kích thước main)
                             main  (PNG phôi, tuỳ chọn — cho shape "main")
                             params JSON: { material, shape, widthMm, borderMm, thicknessMm, shadow, gloss, dpi, preset }
                  → zip: print.png (dpi thật) · white.png (lớp mực trắng, acrylic) · cut.svg (mm) · preview.png · meta.json
POST /render      multipart: file, main?, scene? (ảnh nền), params (+ scene: {x,y,width,rotation}, maxSide)
                  → PNG sản phẩm đã render (đặt lên ảnh nền nếu có)
GET  /health
```

`preset` = các núm render của vật liệu (màu mặt, màu cạnh, bevel, finish…), lấy từ `customize-tool/lib/materials.ts`
— danh mục vật liệu chỉ có 1 nơi.

`white.png`: đen = in mực trắng. `acrylic_white` lót trắng cả plate; `acrylic_clear` chỉ dưới hình (co 1px);
sứ / nhôm / gỗ không cần.

`meta.json`: kích thước mm, diện tích plate, chiều dài đường cắt (tính giá / xếp tấm), và `warnings`
(plate bị tách nhiều mảnh, ảnh bị phóng to quá 1.5× để đạt dpi).

Tốc độ (M1 CPU): file in 140 mm @ 300 dpi ≈ 2.5 s; `/render` 1200 px ≈ 0.6 s.

## Chạy

```bash
./run-local.sh                 # http://127.0.0.1:7003 (npm run dev tự bật)
docker build -t material-render . && docker run -p 7003:7003 material-render
```

Env: `MATERIAL_TOKEN` (Bearer), `MATERIAL_MAX_BYTES` (40 MB), `MATERIAL_MAX_SIDE` (12000 px).
