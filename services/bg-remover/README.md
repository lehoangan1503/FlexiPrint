# bg-remover

Microservice xoá phông / tách chủ thể — [rembg](https://github.com/danielgatis/rembg) + model **BiRefNet** (MIT) sau 1 endpoint HTTP.
Không gọi API trả phí, không phải AI tạo ảnh: model chỉ tính mask, **giữ nguyên pixel ảnh gốc**.

Dùng bởi Customize Tool (`customize-tool/server/ai/photo.ts`) qua env `CT_BG_REMOVER_URL`, nhưng không phụ thuộc gì vào app — service nào cũng gọi được.

## API

```
POST /remove     multipart: file (PNG/JPEG/WebP, ≤15MB) → image/png có alpha
                 query: model=birefnet-general  decontaminate=true  post_process=true
                 header (nếu đặt BG_TOKEN): Authorization: Bearer <token>
                 response headers: X-Model, X-Elapsed-Ms
GET  /health     → {"status":"ok","model":"birefnet-general","loaded":[...]}
GET  /docs       Swagger UI
```

```bash
curl -F file=@cat.jpg http://127.0.0.1:7001/remove -o cat.png
```

## Chạy

Local (không cần Docker, Python 3.11–3.13 + uv):
```bash
./run-local.sh                 # http://127.0.0.1:7001 — lần đầu tải model ~1GB về ~/.rembg/models
```

Docker (model được bake sẵn trong image, cold start không phải tải):
```bash
docker compose up -d --build
```

Rồi trong app Next (`.env.local`):
```
CT_BG_REMOVER_URL=http://127.0.0.1:7001
# CT_BG_REMOVER_TOKEN=...      # nếu service đặt BG_TOKEN
```

## Cấu hình

| Env | Mặc định | |
|---|---|---|
| `BG_MODEL` | `birefnet-general` | Model mặc định. `birefnet-general-lite` nhanh hơn ~3×, viền kém hơn chút. **Không dùng `bria-rmbg` cho thương mại** (license non-commercial) |
| `BG_MODELS` | = `BG_MODEL` | Danh sách model caller được chọn qua `?model=` |
| `BG_TOKEN` | — | Bắt buộc Bearer token |
| `BG_MAX_BYTES` | 15MB | Giới hạn upload |
| `BG_MAX_SIDE` | 2048 | Ảnh to hơn bị thu nhỏ trước khi chạy model |
| `BG_CONCURRENCY` | 1 | Số ảnh xử lý song song — mỗi lần chạy BiRefNet chiếm ~2–3GB RAM |
| `BG_PROVIDERS` | `CPUExecutionProvider` | onnxruntime providers. Trên máy NVIDIA: cài `rembg[gpu]` + `CUDAExecutionProvider` |

## Ghi chú vận hành

- Ảnh điện thoại được xoay theo EXIF trước khi vào model.
- `decontaminate` kéo màu nền ra khỏi pixel bán trong suốt ở viền (lông, tóc) — tránh viền xanh cỏ quanh con mèo.
- 1 process = 1 bản model trong RAM. Scale ngang bằng thêm container, đừng tăng `--workers` trong cùng container nhỏ.
