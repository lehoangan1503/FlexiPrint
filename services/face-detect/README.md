# face-detect

Finds the face in a customer photo and crops the head around it — the **Face**
styles of a photo zone (customize-tool `lib/photo-styles.ts`). CPU only, no
paid API, ~250 MB image.

| Detector | Finds | Source |
|---|---|---|
| YuNet (OpenCV DNN) | people (often dogs too) | `models/face_detection_yunet_2023mar.onnx` (downloaded on first start / at docker build) |
| Haar `frontalcatface(_extended)` | cats | ships with OpenCV |
| BiSeNet face parsing (CelebAMask-HQ, MIT) | which pixels of a **person's** head are skin / hair / ears vs neck / clothes | `models/face_parsing_resnet18.onnx`, ~50 MB (downloaded on first start / at docker build) |

Nothing found → `422 No face found`. The app (`server/ai/photo.ts`) asks
Gemini on fal.ai for the eyes / chin of anything that isn't a person (if
`FAL_KEY` is set) and calls `/crop` again with `box=` / `eyes=` / `chin=`:
the cat cascade misses most pets (tried: 1 cat in 5). An open-vocabulary
detector (OWLv2 ONNX, Apache-2.0) was tried too — "cat face" / "cat head"
boxes the whole cat, so it isn't used.

```
POST /detect   multipart file → {width, height, faces: [{x, y, w, h, score, kind}]}   px, biggest first
POST /crop     multipart file (+ photo = the original, box="x,y,w,h", eyes="x1,y1,x2,y2", chin="x,y" as 0–1 fractions) ?shape=face|box → image/png
               headers X-Face-Box, X-Face-Kind · 422 when no face
GET  /health   → {"status", "detectors", "parsing": true when the parsing model loaded}
```

The app sends the **cut-out** (bg-remover output) plus the original `photo`:
the head is cut from the photo's own pixels at full resolution, under the
cut-out's alpha (scaled up to it), and never scaled down — the editor /
storefront scale it once, into the zone's child frame.

**People** are cut by face parsing: skin, brows, eyes, glasses, ears, nose,
lips, hair, hat are kept; neck, clothes and background dropped. So the outline
is the person's own — hair falling beside the cheeks stays, the chin is the
real jaw line (no drawn oval). Hair hanging further than ~1 eye distance under
the chin fades out. YuNet also fires on pets: when the parser finds no human
face at the eyes + nose (`PARSE_MIN_CORE`), the head is cut like a pet's.

**Pets** (and people when the parsing model is missing) use the drawn outline.
The head is measured in
eye distances from the eye midpoint (eyes are what every locator gets right;
face boxes vary wildly) and turned upright. Above the eye line a wide, tall
half-ellipse leaves room for ears / hair; below it the jaw narrows to the
chin. Inside that outline the cut-out's own alpha is the edge — ears and fur
come out whole — and only the jaw is a drawn line: no neck, no body, no
background. The outline is centred on the head's own edges across the cheeks (read from
the cut-out), not on the located eyes — those are often a few % off, which
cut one cheek and kept the other. Only the blob joined to the face is kept (a paw, a second pet
drop out). Without alpha the outline itself is the edge (tighter). See
`PROFILES` in `app.py`. The browser then applies the colour filter.

Env: `FD_TOKEN` (Bearer), `FD_MAX_BYTES` (15 MB), `FD_MAX_SIDE` (4096), `FD_MIN_SCORE` (0.7).

```bash
./run-local.sh          # → http://127.0.0.1:7004  (npm run dev starts it)
```
