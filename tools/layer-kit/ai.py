"""Tiny AI image client (fal nano-banana-2, CPA gpt-image) — keys read from the repo's .env.local, never printed."""
import base64, io, json, os, sys, time
import requests
from PIL import Image

ENV = {}
for line in open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".env.local")):
    line = line.strip()
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1)
        ENV[k] = v.strip().strip('"').strip("'")

def _uri(img: Image.Image) -> str:
    b = io.BytesIO(); img.save(b, "PNG")
    return "data:image/png;base64," + base64.b64encode(b.getvalue()).decode()

def _get(url: str) -> Image.Image:
    if url.startswith("data:"):
        return Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1]))).convert("RGBA")
    return Image.open(io.BytesIO(requests.get(url, timeout=120).content)).convert("RGBA")

def fal(prompt: str, images=(), aspect="2:3", tries=3) -> Image.Image:
    url = "https://fal.run/fal-ai/nano-banana-2" + ("/edit" if images else "")
    body = {"prompt": prompt, "num_images": 1, "output_format": "png", "resolution": "2K"}
    if images: body["image_urls"] = [_uri(i) for i in images]
    else: body["aspect_ratio"] = aspect
    for t in range(tries):
        r = requests.post(url, json=body, headers={"Authorization": "Key " + ENV["FAL_KEY"]}, timeout=600)
        if r.ok: return _get(r.json()["images"][0]["url"])
        print("fal error", r.status_code, r.text[:300], file=sys.stderr); time.sleep(3)
    raise RuntimeError("fal failed")

def cpa(prompt: str, images=(), size="1024x1536", model="gpt-image-2.5") -> Image.Image:
    base = ENV.get("CPA_BASE_URL") or "https://cpa.next.lc/v1"
    body = {"model": model, "prompt": prompt, "size": size}
    if images: body["images"] = [{"image_url": _uri(i)} for i in images]
    r = requests.post(base + ("/images/edits" if images else "/images/generations"), json=body,
                      headers={"Authorization": "Bearer " + ENV["CPA_API_KEY"]}, timeout=600)
    if not r.ok: raise RuntimeError(f"cpa {r.status_code} {r.text[:300]}")
    return Image.open(io.BytesIO(base64.b64decode(r.json()["data"][0]["b64_json"]))).convert("RGBA")
