"""
layer-kit — cuts a pixel-registered layer set out of one AI master and its in-place edits (v2 bộ nhân vật,
customize-tool/server/char/cut.ts). Rules: flexiprint://guide/layer-rules. No model of its own: matting goes to
bg-remover; the print upscale is Real-ESRGAN on CPU (upscale.py). Three jobs, each reviewed by hand in between:

    POST /matte   {"master"} → {"job"}          the master at print size without its backdrop
                  result {"width","height","factor","files": {"colour","alpha"}}
    POST /matte/fix {"colour","alpha","points"} → {"alpha": base64, "removed"}   (no job: a few seconds)
                  "Sửa nền": backdrop left over at the points marked on the page is removed (layers.erase_at)
    POST /plan    PlanBody → {"job"}            every layer's region on its picture (edits registered, upscaled)
                  result {"width","height","pictures":[…],"pieces":[…],"checks","align"}
    POST /cut     CutBody → {"job"}             the files: region × subject alpha (+ recolours, back / front)
                  result {"width","height","crop","order","files":[{…,"png": base64}],"zones","checks","diff"}
    GET  /jobs/{job}                → {"status": running|done|failed, "result"|"error"}
    GET  /jobs/{job}/files/{name}   a picture / mask PNG the job wrote (masks: white, alpha = the mask)
    DELETE /jobs/{job}              forget it (else after an hour)
    POST /align   {"ref": url, "url": url} → {"dx", "dy", "unchanged", "before", "residual", "max", "w", "h"}
    GET  /health

Env:
    BG_REMOVER_URL   bg-remover base url (http://127.0.0.1:7001)
    LAYER_TOKEN      if set, callers must send `Authorization: Bearer <token>`
"""

from __future__ import annotations

import asyncio
import shutil
import tempfile
import base64
import io
import logging
import os
import time
import uuid

import cv2
import numpy as np
import requests
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from PIL import Image
from pydantic import BaseModel

import upscale
from layers import (Option, Slot, Zone, claim_orphans, cut, cut_of, erase_at, keep_of, kernel, magenta, mix, on_white, region_body, region_painted, region_shape,
                    region_zone, regions_colour, register)

BG = os.getenv("BG_REMOVER_URL", "http://127.0.0.1:7001").rstrip("/")
TOKEN = os.getenv("LAYER_TOKEN", "")
MAX_SIDE = 2048  # segmentation runs on a downscaled copy; it only votes — the paper is found on the pixels (layers.backdrop_of)
PRINT_SIDE = int(os.getenv("PRINT_SIDE", "3072"))  # long side wanted for print (≈ 300 dpi at 26 cm)

log = logging.getLogger("layer-kit")
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
app = FastAPI(title="layer-kit")
_lock = asyncio.Lock()


def auth(h: str | None) -> None:
    if TOKEN and h != f"Bearer {TOKEN}":
        raise HTTPException(401, "unauthorized")


def fetch(url: str) -> Image.Image:
    r = requests.get(url, timeout=120)
    if not r.ok:
        raise HTTPException(400, f"cannot download {url}: {r.status_code}")
    img = Image.open(io.BytesIO(r.content))
    img.load()
    return img


def rgb_on_white(img: Image.Image) -> np.ndarray:
    im = img.convert("RGBA")
    white = Image.new("RGBA", im.size, (255, 255, 255, 255))
    return np.asarray(Image.alpha_composite(white, im).convert("RGB")).astype(np.float32) / 255


def fit(arr: np.ndarray, w: int, h: int) -> np.ndarray:
    """Onto a w×h canvas the way the image models do it: ONE uniform scale that covers the canvas, then a centre
    crop (measured: nano-banana-2 maps 2560×1706 → 2528×1684 like this, 0.006 px; a plain resize to w×h stretches
    the axes differently and shows as a ~0.7 px shift)."""
    ah, aw = arr.shape[:2]
    if aw == w and ah == h:
        return arr
    k = max(w / aw, h / ah)
    sw, sh = max(w, round(aw * k)), max(h, round(ah * k))
    interp = cv2.INTER_AREA if k < 1 else cv2.INTER_LANCZOS4
    big = cv2.resize(arr, (sw, sh), interpolation=interp)
    x, y = (sw - w) // 2, (sh - h) // 2
    return np.clip(big[y:y + h, x:x + w], 0, 1)


def matte(rgb: np.ndarray) -> np.ndarray:
    """bg-remover alpha of a picture on white (at ≤ MAX_SIDE)."""
    h, w = rgb.shape[:2]
    k = min(1.0, MAX_SIDE / max(h, w))
    small = cv2.resize(rgb, (round(w * k), round(h * k)), interpolation=cv2.INTER_AREA) if k < 1 else rgb
    buf = io.BytesIO()
    Image.fromarray((small * 255).round().astype(np.uint8)).save(buf, "PNG")
    r = requests.post(f"{BG}/remove", files={"file": ("in.png", buf.getvalue(), "image/png")}, timeout=600)
    if not r.ok:
        raise HTTPException(502, f"bg-remover {r.status_code}: {r.text[:200]}")
    a = np.asarray(Image.open(io.BytesIO(r.content)).convert("RGBA").getchannel("A")).astype(np.float32) / 255
    return a


def png_b64(rgba: np.ndarray) -> str:
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, "PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode()


def bbox(rgba: np.ndarray) -> list[int]:
    """[x, y, w, h] of a file's visible pixels (the page zooms its thumbnail there)."""
    ys, xs = np.where(rgba[..., 3] > 8)
    if not len(xs):
        return [0, 0, rgba.shape[1], rgba.shape[0]]
    return [int(xs.min()), int(ys.min()), int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)]


def rgba_of(img: Image.Image) -> np.ndarray:
    return np.asarray(img.convert("RGBA")).astype(np.float32) / 255


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


class AlignBody(BaseModel):
    ref: str
    url: str


@app.post("/align")
def align_edit(body: AlignBody, authorization: str | None = Header(default=None)) -> dict:
    auth(authorization)
    ref = rgb_on_white(fetch(body.ref))
    img = rgb_on_white(fetch(body.url))
    h, w = img.shape[:2]
    _, out = register(fit(ref, w, h), img)
    out.update({"w": w, "h": h})
    return out


# ---- jobs ---------------------------------------------------------------------------------------------------
# A job takes minutes (registration, matting, upscale) — longer than an HTTP client waits for headers (Node's
# fetch: 300 s). POST starts it; GET /jobs/{id} answers {"status": "running"|"done"|"failed", ...}; the pictures a
# job writes are fetched one by one (GET /jobs/{id}/files/{name}), then the caller deletes the job.

_jobs: dict[str, dict] = {}
JOBS_DIR = os.getenv("JOBS_DIR", os.path.join(tempfile.gettempdir(), "layer-kit-jobs"))


def _job_dir(job_id: str) -> str:
    return os.path.join(JOBS_DIR, job_id)


def _forget(job_id: str) -> None:
    _jobs.pop(job_id, None)
    shutil.rmtree(_job_dir(job_id), ignore_errors=True)


async def _run_job(job_id: str, fn, body) -> None:
    try:
        async with _lock:  # one job at a time: a few GB of float arrays
            result = await asyncio.to_thread(fn, body, _job_dir(job_id))
            _jobs[job_id] = {"status": "done", "result": result, "at": time.time()}
    except Exception as e:  # noqa: BLE001 — the caller reads it
        log.exception("job %s failed", job_id)
        detail = e.detail if isinstance(e, HTTPException) else str(e)
        _jobs[job_id] = {"status": "failed", "error": str(detail)[:1000], "at": time.time()}


def _start(fn, body) -> dict:
    for k in [k for k, j in _jobs.items() if j["status"] != "running" and time.time() - j["at"] > 3600]:
        _forget(k)
    job_id = uuid.uuid4().hex
    os.makedirs(_job_dir(job_id), exist_ok=True)
    _jobs[job_id] = {"status": "running", "at": time.time()}
    asyncio.create_task(_run_job(job_id, fn, body))
    return {"job": job_id}


@app.get("/jobs/{job_id}")
def get_job(job_id: str, authorization: str | None = Header(default=None)) -> dict:
    auth(authorization)
    j = _jobs.get(job_id)
    if not j:
        raise HTTPException(404, "no such job (layer-kit restarted?)")
    if j["status"] == "running":
        return {"status": "running"}
    return {"status": j["status"], **({"result": j["result"]} if j["status"] == "done" else {"error": j["error"]})}


@app.get("/jobs/{job_id}/files/{name}")
def job_file(job_id: str, name: str, authorization: str | None = Header(default=None)) -> FileResponse:
    auth(authorization)
    path = os.path.join(_job_dir(job_id), os.path.basename(name))
    if job_id not in _jobs or not os.path.isfile(path):
        raise HTTPException(404, "no such file")
    return FileResponse(path, media_type="image/png")


@app.delete("/jobs/{job_id}")
def delete_job(job_id: str, authorization: str | None = Header(default=None)) -> dict:
    auth(authorization)
    _forget(job_id)
    return {"ok": True}


# ---- pictures in and out ------------------------------------------------------------------------------------

def read_mask(img: Image.Image) -> np.ndarray:
    """A mask PNG: its alpha (white + alpha, how the page saves them), or its grey levels when it has none."""
    if img.mode in ("RGBA", "LA", "PA") or "transparency" in img.info:
        return np.asarray(img.convert("RGBA").getchannel("A")).astype(np.float32) / 255
    return np.asarray(img.convert("L")).astype(np.float32) / 255


def write_colour(out_dir: str, name: str, rgb: np.ndarray) -> str:
    Image.fromarray((np.clip(rgb, 0, 1) * 255).round().astype(np.uint8), "RGB").save(os.path.join(out_dir, name), "PNG", compress_level=4)
    return name


def write_mask(out_dir: str, name: str, a: np.ndarray) -> str:
    h, w = a.shape
    rgba = np.full((h, w, 4), 255, np.uint8)
    rgba[..., 3] = (np.clip(a, 0, 1) * 255).round().astype(np.uint8)
    Image.fromarray(rgba, "RGBA").save(os.path.join(out_dir, name), "PNG", compress_level=6)
    return name


def print_factor(w: int, h: int) -> float:
    """×2 exactly (gpt-image 1536 → 3072), only when the picture is well under the print size."""
    return 2.0 if upscale.available() and max(w, h) * 2 <= PRINT_SIDE * 1.3 else 1.0


# ---- 1. matte -----------------------------------------------------------------------------------------------

class MatteBody(BaseModel):
    master: str


def _matte(body: MatteBody, out_dir: str) -> dict:
    t0 = time.time()
    work = rgb_on_white(fetch(body.master))
    h, w = work.shape[:2]
    coarse = matte(work)
    factor = print_factor(w, h)
    up = upscale.upscale2(work) if factor > 1 else work
    rgba = cut_of(work, up, coarse)
    log.info("matte %d×%d ×%.0f in %.1fs", w, h, factor, time.time() - t0)
    return {
        "width": up.shape[1],
        "height": up.shape[0],
        "factor": factor,
        "files": {"colour": write_colour(out_dir, "colour.png", rgba[..., :3]), "alpha": write_mask(out_dir, "alpha.png", rgba[..., 3])},
    }


@app.post("/matte")
async def start_matte(body: MatteBody, authorization: str | None = Header(default=None)) -> dict:
    auth(authorization)
    return _start(_matte, body)


class MattePoint(BaseModel):
    x: float
    y: float


class MatteFixBody(BaseModel):
    colour: str            # /matte colours (print size)
    alpha: str             # the alpha now
    points: list[MattePoint]


@app.post("/matte/fix")
def fix_matte(body: MatteFixBody, authorization: str | None = Header(default=None)) -> dict:
    """"Sửa nền": backdrop left over at the marked points is removed (layers.erase_at) — a few seconds, no job."""
    auth(authorization)
    if not body.points or len(body.points) > 300:
        raise HTTPException(400, "1–300 điểm")
    t0 = time.time()
    a = read_mask(fetch(body.alpha))
    col = rgba_of(fetch(body.colour))[..., :3]
    if col.shape[:2] != a.shape:
        raise HTTPException(400, "colour / alpha không cùng cỡ")
    out, removed = erase_at(on_white(col, a), a, [(p.x, p.y) for p in body.points])
    h, w = out.shape
    rgba = np.full((h, w, 4), 255, np.uint8)
    rgba[..., 3] = (np.clip(out, 0, 1) * 255).round().astype(np.uint8)
    log.info("matte fix %d points in %.1fs", len(body.points), time.time() - t0)
    return {"alpha": png_b64(rgba), "removed": removed}


# ---- 2. plan ------------------------------------------------------------------------------------------------

class PlanOption(BaseModel):
    name: str
    hex: str | None = None
    url: str | None = None


class PlanSlot(BaseModel):
    key: str
    label: str
    mode: str
    mask: str | None = None
    options: list[PlanOption]
    colors: list[PlanOption] = []
    wraps: bool = False


class PlanZone(BaseModel):
    id: str
    label: str = ""
    mask: str


class PlanBody(BaseModel):
    source: str            # the approved master as the image model drew it (the edits are registered to it)
    colour: str            # /matte colours (print size)
    alpha: str             # /matte alpha, fixed by hand
    base: str | None = None
    slots: list[PlanSlot]
    zones: list[PlanZone] = []


def _plan(body: PlanBody, out_dir: str) -> dict:
    t0 = time.time()
    src = rgb_on_white(fetch(body.source))
    # The canvas is the edits' own size (the model's native one); the master is mapped onto it.
    first_edit = body.base or next((s.mask for s in body.slots if s.mask), None) or next((o.url for s in body.slots for o in s.options[1:] if o.url), None) or next((z.mask for z in body.zones), None)
    if first_edit:
        probe = fetch(first_edit)
        H, W = probe.height, probe.width
    else:
        H, W = src.shape[:2]
    master_n = fit(src, W, H)
    factor = print_factor(W, H)
    size = (round(W * factor), round(H * factor))

    def up(x: np.ndarray) -> np.ndarray:
        return upscale.upscale2(x) if factor > 1 else x

    def to_size(m: np.ndarray) -> np.ndarray:
        return cv2.resize(m, size, interpolation=cv2.INTER_LINEAR) if m.shape[:2] != (size[1], size[0]) else m

    col_m = fit(rgba_of(fetch(body.colour))[..., :3], *size)
    a_m = np.clip(fit(read_mask(fetch(body.alpha)), *size), 0, 1)
    m_white = on_white(col_m, a_m)
    aligns: dict[str, dict] = {}
    by_url: dict[str, dict] = {}

    def edit(url: str, ref: np.ndarray, role: str) -> np.ndarray:
        img, a = register(ref, fit(rgb_on_white(fetch(url)), W, H))
        aligns[role] = by_url[url] = a
        return img

    pictures: list[dict] = [{"id": "master", "label": "Master", "parent": None}]
    pieces: list[dict] = []
    checks: list[dict] = []

    def picture(pid: str, label: str, col: np.ndarray, own: np.ndarray | None, keep: np.ndarray | None, eff: np.ndarray | None, parent: str | None) -> None:
        p = {"id": pid, "label": label, "parent": parent, "colour": write_colour(out_dir, f"{pid}.colour.png", col)}
        if eff is not None:
            p["alpha"] = write_mask(out_dir, f"{pid}.alpha.png", eff)
        if own is not None and keep is not None:
            p["own"] = write_mask(out_dir, f"{pid}.own.png", own)
            p["keep"] = write_mask(out_dir, f"{pid}.keep.png", keep)
        pictures.append(p)

    def piece(key: str, slot: str, kind: str, label: str, pid: str, region: np.ndarray, option: str = "", index: int = 0) -> None:
        pieces.append({"key": key, "slot": slot, "kind": kind, "label": label, "option": option, "index": index, "picture": pid, "region": write_mask(out_dir, f"region.{len(pieces)}.png", region)})

    def shape_piece(s: PlanSlot, i: int, name: str, key: str, pid: str, reg: np.ndarray) -> None:
        n = int((reg > 0.5).sum())
        checks.append({"name": f"Vùng {s.label}: {name}", "ok": n >= 500, "detail": f"{n:,} px" if n >= 500 else "Không tách được phần thay đổi — tô vùng bằng tay hoặc làm lại bản sửa.", "piece": key})
        piece(key, s.key, "part", f"{s.label}: {name}", pid, reg, name, i)

    # Base: the master with every shape part removed. Where it kept the master, the master's (hand-fixed) alpha holds.
    if body.base:
        base_n, aligns["base"] = register(master_n, fit(rgb_on_white(fetch(body.base)), W, H))
        by_url[body.base] = aligns["base"]
        base_up = up(base_n)
        own = cut_of(base_n, base_up, matte(base_n))
        keep = to_size(keep_of(base_n, master_n))
        base_a = mix(keep, a_m, own[..., 3])
        base_col = mix(keep, col_m, own[..., :3])
        picture("base", "Bản gốc (bỏ phần đổi kiểu)", base_col, own[..., 3], keep, base_a, "master")
        base_pid, base_white = "base", base_up
        del own
    else:
        base_n, base_col, base_a, base_pid, base_white = master_n, col_m, a_m, "master", m_white

    # Colour / texture parts: the magenta the AI painted on the base.
    masks: dict[str, tuple[str, np.ndarray]] = {}
    for s in body.slots:
        if s.mode in ("color", "texture") and s.mask:
            masks[s.key] = (s.label, to_size(edit(s.mask, base_n, f"vùng {s.label}")))
    regions, cs = regions_colour(base_col, base_a, masks)
    checks += cs
    del masks
    for s in body.slots:
        if s.mode not in ("color", "texture"):
            continue
        if s.key in regions:
            piece(s.key, s.key, "part", s.label, base_pid, regions[s.key])
        if s.mode == "texture":
            for i, o in enumerate(s.options):
                if i > 0 and o.url:
                    tex = up(edit(o.url, base_n, f"{s.label}: {o.name}"))
                    picture(f"tex.{s.key}.{i}", f"{s.label}: {o.name}", tex, None, None, None, base_pid)

    # Shape parts: the master's own (master − base) and each option (edit − base).
    shapes = [s for s in body.slots if s.mode == "shape"]
    # The master's own parts: the magenta the AI painted on the master in 3b ("Tô …") — exact, so it is the region.
    painted: dict[str, np.ndarray] = {}
    for s in shapes:
        if s.mask:
            painted[s.key] = to_size(magenta(edit(s.mask, master_n, f"tô {s.label}")).astype(np.float32)) > 0.5
    max_d = 12 * factor
    master_regions: list[tuple[str, str, str, np.ndarray]] = []   # (piece key, slot, label/option, region)
    for s in shapes:
        hairlike = bool(s.colors)
        for i, o in enumerate(s.options):
            key = f"{s.key}#{i}"
            if i == 0:
                if s.key in painted:
                    others = np.zeros(a_m.shape, bool)
                    for k, m in painted.items():
                        if k != s.key:
                            others |= m
                    reg = region_painted(painted[s.key], m_white, a_m, base_white, base_a, others, round(4 * factor))
                else:
                    reg = region_shape(m_white, a_m, base_white, base_a, None, hairlike)
                master_regions.append((key, s.key, o.name, reg))
                continue
            if not o.url:
                continue
            e_n = edit(o.url, base_n, f"{s.label}: {o.name}")
            e_up = up(e_n)
            own = cut_of(e_n, e_up, matte(e_n))
            keep = to_size(keep_of(e_n, base_n))
            e_a = mix(keep, base_a, own[..., 3])
            pid = f"opt.{s.key}.{i}"
            picture(pid, f"{s.label}: {o.name}", mix(keep, base_col, own[..., :3]), own[..., 3], keep, e_a, base_pid)
            reg = claim_orphans([region_shape(e_up, e_a, base_white, base_a, None, hairlike)], e_a, base_a, max_d)[0]
            del own, e_up, e_n
            shape_piece(s, i, o.name, key, pid, reg)
    # The master's parts share its outside-the-body pixels: each orphan goes to the nearest part.
    claimed = claim_orphans([r for *_, r in master_regions], a_m, base_a, max_d)
    for (key, slot_key, name, _), reg in zip(master_regions, claimed):
        s = next(x for x in shapes if x.key == slot_key)
        shape_piece(s, 0, name, key, "master", reg)

    for z in body.zones:
        reg = to_size(region_zone(edit(z.mask, base_n, f"vùng ảnh {z.id}")))
        ok = int((reg > 0.5).sum()) >= 500
        checks.append({"name": f"Vùng ảnh khách: {z.label or z.id}", "ok": ok, "detail": "" if ok else "AI không tô được — tô vùng bằng tay.", "piece": f"zone:{z.id}"})
        piece(f"zone:{z.id}", f"zone:{z.id}", "zone", f"Vùng ảnh khách: {z.label or z.id}", base_pid, reg)
    piece("body", "body", "body", "Thân", base_pid, region_body(base_a))

    for role, a in aligns.items():
        ok = a["residual"] <= 0.3 and a["before"] <= 3.0
        checks.insert(0, {"name": f"Khớp: {role}", "ok": ok, "detail": f"lệch {a['before']:.2f} → {a['residual']:.2f} px (tệ nhất {a['max']:.2f})"})
    log.info("plan: %d pictures, %d pieces in %.1fs", len(pictures), len(pieces), time.time() - t0)
    return {"width": size[0], "height": size[1], "factor": factor, "pictures": pictures, "pieces": pieces, "checks": checks, "align": by_url}


@app.post("/plan")
async def start_plan(body: PlanBody, authorization: str | None = Header(default=None)) -> dict:
    auth(authorization)
    return _start(_plan, body)


# ---- 3. cut -------------------------------------------------------------------------------------------------

class CutPicture(BaseModel):
    colour: str
    alpha: str | None = None    # master: its (hand-fixed) alpha
    own: str | None = None      # an edit: its own matte …
    keep: str | None = None     # … and where it kept its parent (the parent's alpha holds there)
    parent: str | None = None


class CutOption(BaseModel):
    name: str
    hex: str | None = None
    picture: str | None = None
    region: str | None = None


class CutSlot(BaseModel):
    key: str
    label: str
    mode: str
    wraps: bool = False
    region: str | None = None
    options: list[CutOption]
    colors: list[CutOption] = []


class CutZone(BaseModel):
    id: str
    region: str


class CutBody(BaseModel):
    pictures: dict[str, CutPicture]
    body_picture: str
    body_region: str
    slots: list[CutSlot]
    zones: list[CutZone] = []


def _cut(body: CutBody, out_dir: str) -> dict:
    t0 = time.time()
    m = body.pictures["master"]
    col_m = rgba_of(fetch(m.colour))[..., :3]
    H, W = col_m.shape[:2]
    a_m = read_mask(fetch(m.alpha)) if m.alpha else np.ones((H, W), np.float32)
    cache: dict[str, tuple[np.ndarray, np.ndarray | None]] = {"master": (col_m, a_m)}

    def sized(x: np.ndarray) -> np.ndarray:
        return x if x.shape[:2] == (H, W) else cv2.resize(x, (W, H), interpolation=cv2.INTER_LINEAR)

    def pic(pid: str) -> tuple[np.ndarray, np.ndarray | None]:
        if pid not in cache:
            p = body.pictures[pid]
            col = sized(rgba_of(fetch(p.colour))[..., :3])
            a = None
            if p.own and p.keep and p.parent:
                a = mix(sized(read_mask(fetch(p.keep))), pic(p.parent)[1], sized(read_mask(fetch(p.own))))
            elif p.alpha:
                a = sized(read_mask(fetch(p.alpha)))
            cache[pid] = (col, a)
        return cache[pid]

    def region(url: str | None) -> np.ndarray | None:
        return sized(read_mask(fetch(url))) if url else None

    base_col, base_a = pic(body.body_picture)
    slots: list[Slot] = []
    for s in body.slots:
        slot = Slot(s.key, s.label, s.mode, region=region(s.region), wraps=s.wraps)
        for o in s.options:
            opt = Option(o.name, o.hex)
            if o.picture:
                opt.col, opt.alpha = pic(o.picture)
            opt.region = region(o.region)
            slot.options.append(opt)
        slot.colors = [Option(c.name, c.hex) for c in s.colors]
        slots.append(slot)
    zones = [Zone(z.id, region(z.region)) for z in body.zones]
    base_a = base_a if base_a is not None else a_m
    if body.body_picture != "master":
        # The base is an AI edit: besides removing the hair it re-draws a little (eyes, brows). Where the master
        # shows the body itself (outside every master part's region, inside both silhouettes) the body takes the
        # master's own pixels — the stacked default is then the master, face included.
        parts = np.zeros((H, W), bool)
        for sl in slots:
            if sl.mode == "shape" and sl.options and sl.options[0].region is not None:
                parts |= sl.options[0].region > 0.2
        parts = cv2.dilate(parts.astype(np.uint8), kernel(8)).astype(bool)
        own_body = cv2.GaussianBlur((~parts & (base_a > 0.5) & (a_m > 0.5)).astype(np.float32), (0, 0), 1.5)
        base_col = mix(own_body, col_m, base_col)
    out = cut(col_m, a_m, base_col, base_a, region(body.body_region), slots, zones)
    log.info("cut %d files in %.1fs", len(out["files"]), time.time() - t0)
    return {
        "width": out["width"],
        "height": out["height"],
        "crop": out["crop"],
        "master": out["master"],
        "order": out["order"],
        "zones": out["zones"],
        "checks": out["checks"],
        "diff": png_b64(out["diff"]),
        "files": [{"slot": f.slot, "label": f.label, "option": f.option, "color": f.color, "piece": f.piece, "png": png_b64(f.rgba), "bbox": bbox(f.rgba)} for f in out["files"]],
    }


@app.post("/cut")
async def start_cut(body: CutBody, authorization: str | None = Header(default=None)) -> dict:
    auth(authorization)
    return _start(_cut, body)
