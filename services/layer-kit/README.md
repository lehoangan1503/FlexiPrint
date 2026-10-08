# layer-kit

Cuts a **pixel-registered layer set** out of one AI master and its in-place edits — the v2 bộ nhân vật
(`/v2` pages, `customize-tool/server/char/layers.ts`). Rules: `customize-tool/server/mcp/layer-rules.ts`.

```
POST /align   {"ref": url, "url": url}  → shift of an edit against its source (on the edit's own canvas)
POST /build   plan JSON                 → layer PNGs (base64) + order + photo-zone polygons + checks
GET  /health
```

What `/build` does (layers.py):

- **Canvas** = the edits' own size (the image model's native one). The working master is mapped onto it with ONE
  uniform scale + centre crop — exactly what nano-banana-2 does to its input (a plain resize stretches the axes
  differently: ~0.7 px).
- **Registration**: every edit is measured against its source (phase correlation) and moved back by that sub-pixel
  shift — a translation, nothing redrawn. Checked again: ≤ 0.1 px or the check fails.
- **Colour slots**: mask = the magenta edit (+ the part's own outline, + same-colour bits next to it); options are
  recolours of the base's own pixels in Lab → identical alpha.
- **Texture slots**: the texture edit's pixels inside that same mask.
- **Shape slots**: option = edit − base (master − base for the first), hair-colour guard, colours = recolours;
  `wraps` → back (whole part, under the body) + front (the part over the body + 2 px).
- **Photo zones**: magenta edit → polygon.
- Checks: registration, masks kept, front ⊆ back, back + body + front = master.

Matting (alpha of the master, the base and each shape edit) is bg-remover (`BG_REMOVER_URL`); only its alpha is used,
the colours are un-mixed from the white background at full size.

Local: `./run-local.sh` (needs bg-remover on :7001). Docker: `docker compose up -d --build layer-kit`.
