# Studio (ComfyUI) — clipart library AI

ComfyUI with the **FlexiPrint node pack**: editors use ComfyUI's own UI, and every node speaks the
FlexiPrint vocabulary (style pack → category + rules → clipart). All image models run over HTTP, so
this is CPU only and holds no model weights.

- **ComfyUI key:** not needed. ComfyUI is open source (GPL-3); a comfy.org key only unlocks their
  paid Partner nodes, and we don't use those.
- **Models:** `cpa:*` goes to the team's OpenAI-compatible images API (`CPA_BASE_URL`, `CPA_API_KEY`).
  `fal:*` goes to fal.ai (`FAL_KEY`).
- **Fallback:** a 429 or 5xx falls back along `FP_FALLBACK_MODELS`
  (default `cpa:grok-imagine-image-quality,fal:fal-ai/nano-banana-2/edit`).

## Nodes (`custom_nodes/flexiprint/nodes.py`)

| Node | What it does |
|---|---|
| FP Style Pack | Preset `style_pack`: how the whole set is drawn |
| FP Category | A library category: shared spec + rules (canvas, fill, anchor, background, silhouette lock). Decides where cliparts are saved and whether they are main or element |
| FP Context Note | Extra context added to every prompt downstream |
| FP Origin Generate | One line = one **original clipart** of the category (each car model, each hobby icon). `chain_reference` keeps the set consistent |
| FP Cutout + Normalize | Cuts out the subject (white key / BiRefNet), trims it, fits it to the category canvas and fill, places it by anchor |
| FP Variant Set | One origin → a **set of colours / styles** with the same silhouette. `recolor` is deterministic; `ai_edit_locked` edits with AI, realigns, re-applies the origin's alpha, and reports IoU |
| FP Material | Material preset (acrylic, glitter, wood…) on a clipart or artwork. Keeps W×H; silhouette lock plus `edge_px` for an acrylic rim |
| FP Mockup Scene | Artwork → a lifestyle marketing photo (preset `scene`) |
| FP Load Clipart / FP Load Artwork | Read from the library or from product composites. Load Clipart also carries its category context |
| FP Save to Library / FP Save Mockup | Save as `origin`, `set_member` or `rendition`, or as a product mockup. Logged in `ct_generations` with the graph that ran |

**Frontend (`js/flexiprint.js`):**
- The *FlexiPrint* sidebar is a library browser: click a clipart and an FP Load Clipart node is added.
- The *Ngữ cảnh* bottom panel shows the prompt the selected node sent to the model.

**Templates:** `example_workflows/` holds 01 origin set, 02 variant set, 03 element pack,
04 clipart material and 05 artwork → mockup. They appear under *Templates → flexiprint*.
To regenerate them, run `python tools/build_workflows.py` against a running ComfyUI.

## How it connects

```
browser ─► https://flexiprint.next.lc/studio   (app page: sets the fp_studio cookie, iframes /comfy/)
        ─► https://flexiprint.next.lc/comfy/*  nginx auth_request → /api/customize-tool/studio/auth
                                              └► 127.0.0.1:8188 (prefix stripped)
comfy nodes ─► http://app:3000/api/customize-tool/internal/*   Bearer FP_COMFY_TOKEN (= CT_COMFY_TOKEN)
```

- **Under a prefix:** ComfyUI runs fine below `/comfy/`. Its frontend derives the API base from the
  page path, and the node pack's dropdown routes are relative (`flexi/options/…`). Only the favicons
  use absolute paths, and those fall through to the app's 404.
- **nginx:** `deploy/nginx/flexiprint-comfy.locations` is included in the 443 server;
  `flexiprint-comfy-map.conf` goes in `conf.d`.
- **App env:**
  - `CT_COMFY_TOKEN`
  - `CT_STUDIO_SECRET`
  - `CT_STUDIO_URL`: default `/comfy/`
  - `CT_STUDIO_USER_ID`: owner of studio-made cliparts; default is the first superadmin
- **Comfy env** (compose sets it):
  - `FP_API_URL`
  - `FP_COMFY_TOKEN`
  - `CPA_BASE_URL`
  - `CPA_API_KEY`
  - `FAL_KEY`
  - `FP_FALLBACK_MODELS`

## Local

```bash
git clone --depth 1 --branch v0.38.0 https://github.com/comfyanonymous/ComfyUI.git ~/comfy
python3.12 -m venv ~/comfy/.venv && ~/comfy/.venv/bin/pip install torch torchvision torchaudio && ~/comfy/.venv/bin/pip install -r ~/comfy/requirements.txt
ln -s "$PWD/custom_nodes/flexiprint" ~/comfy/custom_nodes/flexiprint
FP_API_URL=http://127.0.0.1:3000/api/customize-tool FP_COMFY_TOKEN=$CT_COMFY_TOKEN CPA_API_KEY=… FAL_KEY=… \
  ~/comfy/.venv/bin/python ~/comfy/main.py --cpu --port 8188
```
