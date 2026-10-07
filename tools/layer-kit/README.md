# layer-kit — bộ layer nhân vật khớp pixel bằng AI

Quy trình làm sản phẩm demo "Túi mỹ phẩm — Cô gái ngồi". Luật bắt buộc: `customize-tool/server/mcp/layer-rules.ts`.

```
ai.py       gọi fal nano-banana-2 / CPA gpt-image (key đọc từ .env.local)
align.py    đo độ lệch của một bản AI sửa so với master (phase correlation)
layers.py   master + các bản sửa tại chỗ → bộ layer (thân, áo/quần/giày theo màu, tóc trước/sau) + tự kiểm tra
mockup.py   file in → ảnh túi chụp thẳng (đặt đúng ô in) → ảnh lifestyle bằng AI
```

## 1. Master (một lần)
- `fal(prompt, aspect="2:3")`: nhân vật đủ người, có khoảng trống quanh người, nền trắng phẳng.
- Sửa tại chỗ thành **đầu trọc** (`bald.png`). Đây là master thân người, mọi thứ khác đều sửa từ nó.

## 2. Bản sửa tại chỗ (luôn đưa master vào, luôn kèm câu "giữ nguyên mọi thứ")
```
KEEP = "Keep EVERYTHING else pixel-identical: same face, same pose, same body, same clothes, same position,
        same size, same framing and canvas, same white background. Do not move, zoom, crop or re-draw anything else."
mk_<phần>.png   "Paint ONLY her sweater … solid flat pure magenta #FF00FF …" + KEEP   → mặt nạ của phần đó
hair_<kiểu>.png "Give her a <kiểu tóc> …"                                + KEEP   → tóc = phần thay đổi
```
- Chạy `align.py bald.png <các bản sửa>`. Chỉ dùng bản lệch < 0.5 px. Nano-banana-2 thường lệch khoảng 0.05 px.
- Tách nền bằng bg-remover (`POST :7001/remove`) → thư mục `cut/`. Dịch vụ này thu nhỏ ảnh, nên chỉ lấy kênh alpha.

## 3. `layers.py` → `out/` + `manifest.json`
- **Màu quần áo:** đổi màu chính pixel của master (cùng alpha), không dùng AI vẽ lại.
- **Tóc:**
  - lớp SAU = cả bộ tóc, vẽ dưới thân;
  - lớp TRƯỚC = phần tóc nằm đè lên thân, phủ qua mép thân 2 px để không lộ đường nối.
- **Tự kiểm tra:**
  - lớp trước nằm trọn trong lớp sau;
  - ráp lại (sau + thân + trước) phải khớp ảnh AI gốc.
- **Cắt khung:** mọi file cắt cùng một hình chữ nhật. Pixel trong suốt không mang màu, nên file nhẹ.

## 4. Lên sản phẩm
- Mỗi nhóm lựa chọn là một layer ảnh. Tất cả dùng **cùng một ô**, cùng tỷ lệ với khung file nên vẽ ra 1:1. Transform để mặc định.
- Thứ tự từ dưới lên: tóc sau → thân → quần → áo → giày → tóc trước → chữ.
- Tóc: mỗi màu là một nhóm (ảnh gốc + các biến thể là các kiểu tóc). Layer tóc sau có **"Liên kết theo layer" = tóc trước**, với cùng tên nhóm và cùng thứ tự.
- Nền (Thiết kế → Nền) = ảnh túi chụp thẳng, ô thiết kế = vùng in trên ảnh. Storefront vẽ thiết kế đúng vào ô đó.

## 5. Mockup đẹp
- `mockup.py`: ráp file in lên ảnh túi (thêm chút bóng vải), rồi AI dựng lại thành ảnh lifestyle. Prompt dặn rõ giữ y nguyên hình in và tên.
- Ảnh lifestyle chỉ là ảnh quảng cáo tĩnh. Bản xem trước khách thấy khi chọn luôn là ảnh chụp thẳng + file in, nên luôn chính xác.
