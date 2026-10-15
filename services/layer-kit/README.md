# layer-kit

Cuts a **pixel-registered layer set** of a v2 bộ nhân vật (`/v2` pages, `customize-tool/server/char/`). Rules:
`customize-tool/server/mcp/layer-rules.ts`. Endpoints: see the top of `app.py`.

How a set is cut (rebuilt 2026-10-14, "pixel lock" — `layers.py`):

- gpt-image draws the **paper doll** (every part the customer changes taken off) and then **every option drawn on
  that doll**, in place, on a transparent background.
- `/plan`: each option picture is registered onto the doll (affine + smoothed local flow, ≤ 0.5 px) and upscaled ×2
  (Real-ESRGAN realesr-animevideov3, CPU). Its region = the pixels it drew anew: a clearly different colour (Lab ΔE >
  12) or figure past the doll's outline, minus the 1–2 px lines where an outline only moved (`part_region`). Checks:
  registration, region size, doll figure the picture erased (a layer can only add — draw it again).
- `/cut`: body file = the doll; an option file = region × its picture's alpha in its picture's colours, so the doll +
  that file IS the option picture there. Hair (`wraps`): back = the whole hair, front = the same hair over the doll's
  figure. Other colours = the file recoloured where it has the part's own hue.

No segmentation model, no guessing: a wrong region is fixed by hand in the page or by drawing that picture again.

Local: `./run-local.sh`. Docker: `docker compose up -d --build layer-kit`.
