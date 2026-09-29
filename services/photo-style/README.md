# photo-style

Microservice đổi phong cách ảnh — **không dùng AI**: chỉ là xử lý ảnh cổ điển bằng OpenCV (Apache-2.0).
Không tải model, không cần GPU, không API key; ~0.3–2.5s / ảnh 1400–1600px trên CPU, cùng input luôn ra cùng output.

Dùng bởi Customize Tool (`customize-tool/server/ai/photo.ts`) qua env `CT_PHOTO_STYLE_URL`.

## Style

Mục tiêu: kết quả vẫn **là con vật trong ảnh khách** — đúng màu lông, màu mắt, vằn, ria — hiệu ứng vẽ nằm *trên* ảnh.
Mỗi style: ảnh được đơn giản hoá nhẹ + cộng lại lớp chi tiết của ảnh gốc, nét mực XDoG (Winnemöller 2012),
và `_keep_colour` kéo sắc độ (Lab a/b) về đúng màu ảnh gốc để style không làm lệch màu.

| id | Làm gì |
|---|---|
| `watercolor_ink` | chân dung màu nước kiểu shop (shop dùng AI vẽ lại; đây khớp các quy luật đo được): vẽ vằn chứ không vẽ bóng sáng, 4 lớp màu chia 27/30/20/21 % (giấy / hồng đào / cam nhạt / vằn cam ≈ L71 C50), mắt/mũi giữ màu ảnh gốc + viền mắt đậm, mực chỉ ở viền, mắt/mũi/miệng, ria dài thẳng — không vẽ nét trong lông |
| `oil` | `xphoto.oilPainting` nét nhỏ + 80% chi tiết gốc + vân canvas + gờ sơn (không viền) |

**Viền quanh chủ thể** (ảnh đã tách nền): nét cọ đen lấy từ alpha, dày ~0.5% cạnh dài (tương đối, để không biến mất khi zone thu nhỏ ảnh),
độ dày phình/thon dọc đường viền, bỏ phần mảnh như ria. Chỗ khung ảnh cắt thân, trình duyệt làm mờ nên nét thon dần theo. `styles.OUTLINES`.

Mọi style kết thúc sáng hơn ảnh gốc (`_brighten`: gamma < 1 + nâng điểm đen).

Không có ở đây (làm trên trình duyệt, `customize-tool/lib/photo-process.ts`): `pixel`, và **làm mờ phần bị khung ảnh cắt**
(thân con vật chạm mép ảnh sẽ mờ dần vào main object thay vì 1 đường thẳng).

## API

```
POST /stylize   multipart: file + style=watercolor_ink|oil
                → PNG nếu input trong suốt, ngược lại JPEG
                header (nếu đặt STYLE_TOKEN): Authorization: Bearer <token>
GET  /styles    → {"styles": [...]}
GET  /health
```

```bash
curl -F file=@cat.jpg -F style=watercolor_ink http://127.0.0.1:7002/stylize -o cat-watercolor.jpg
```

## Chạy

```bash
./run-local.sh                  # http://127.0.0.1:7002
docker build -t photo-style . && docker run -p 7002:7002 photo-style
```

App Next (`.env`): `CT_PHOTO_STYLE_URL=http://127.0.0.1:7002` (+ `CT_PHOTO_STYLE_TOKEN` nếu service đặt `STYLE_TOKEN`).

## Giới hạn

Đây là **bộ lọc**, không phải hoạ sĩ: nó biến đổi pixel của chính ảnh, nên ra "ảnh chụp có hiệu ứng vẽ" chứ không vẽ lại
như tranh minh hoạ tay (con mèo watercolor của đối thủ là AI vẽ lại). Muốn giống vẽ tay hơn mà vẫn tự host:
style-transfer neural nhỏ (ONNX, chạy CPU) có thể thêm vào đây sau — xem ghi chú license ở README gốc của repo đó.
