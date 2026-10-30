"""
layer-kit — cuts the layer set of a v2 bộ nhân vật (customize-tool/server/char/cut.ts): a paper doll and every option
drawn on it by gpt-image (in place, transparent background). Rules: flexiprint://guide/layer-rules. A file is the
option picture's pixels where it differs from the doll (layers.part_region) — pixel lock, nothing segmented. The
print upscale is Real-ESRGAN (upscale.py). All on CPU. Three jobs:

    POST /matte   {"master"} → {"job"}          the master's own cut-out (transparent, from gpt-image) at print size
                  result {"width","height","factor","files": {"colour","alpha"}}
    POST /matte/fix {"colour","alpha","points"} → {"alpha": base64, "removed"}   (no job: a few seconds)
                  "Sửa nền": specks left at the points marked on the page are removed (layers.erase_at)
    POST /plan    PlanBody → {"job"}            every option registered onto the doll + upscaled, its region
                  result {"width","height","pictures":[…],"pieces":[…],"checks","align"}
    POST /cut     CutBody → {"job"}             the files: region × the picture's alpha (+ recolours, back / front)
                  result {"width","height","crop","order","files":[{…,"png": base64}],"zones","checks","diff"}
    GET  /jobs/{job}                → {"status": running|done|failed, "result"|"error"}
    GET  /jobs/{job}/files/{name}   a picture / mask PNG the job wrote (masks: white, alpha = the mask)
    DELETE /jobs/{job}              forget it (else after an hour)
    POST /align   {"ref": url, "url": url} → {"dx", "dy", "unchanged", "before", "residual", "max", "w", "h"}
    GET  /health

Env:
    LAYER_TOKEN      if set, callers must send `Authorization: Bearer <token>`
"""

from __future__ import annotations

import asyncio
import shutil
import threading
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

from layers import Option, Slot, Zone, _fill, cut, unit, erase_at, kernel, on_white, part_region, region_zone, register, register_option, shared_lands, territory

TOKEN = os.getenv("LAYER_TOKEN", "")
PRINT_SIDE = int(os.getenv("PRINT_SIDE", "3072"))  # long side wanted for print (≈ 300 dpi at 26 cm)

log = logging.getLogger("layer-kit")
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
app = FastAPI(title="layer-kit")
_lock = asyncio.Lock()
# The quick calls (/align, /matte/fix) are sync endpoints: FastAPI runs up to 40 at once in its thread pool. 47 edits
# finishing together were 47 registrations at once — the 1.6 GB VPS swapped to death (2026-10-18). Two at a time.
_quick = threading.BoundedSemaphore(2)


def auth(h: str | None) -> None:
    if TOKEN and h != f"Bearer {TOKEN}":
        raise HTTPException(401, "unauthorized")


def fetch(url: str) -> Image.Image:
    # Four tries: one slow answer of the file server failed a whole 15-minute plan (2026-10-14); a busy server's 5xx /
    # 429 (60+ files fetched in a row on the small VPS) failed a whole cut (2026-10-18).
    for attempt in range(4):
        try:
            r = requests.get(url, timeout=120)
            if r.status_code < 500 and r.status_code != 429:
                break
        except requests.RequestException:
            if attempt == 3:
                raise
        if attempt < 3:
            time.sleep(3 * (attempt + 1))
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


def transparent_rgba(img: Image.Image, what: str) -> np.ndarray:
    """A picture gpt-image drew on a transparent background (the only cut-out there is — no bg-remover any more,
    asked 2026-10-12: it was never clean). One drawn on a backdrop is refused: redo it."""
    rgba = rgba_of(img)
    if (rgba[..., 3] < 0.03).mean() < 0.02:
        raise HTTPException(400, f"{what}: ảnh không có nền trong suốt — vẽ lại bằng AI (nền trong suốt)")
    return rgba


def print_rgba(rgba: np.ndarray, factor: float, keep: np.ndarray | None = None) -> np.ndarray:
    """A cut-out at print size: colours spread under the transparent edge before the upscale (no dark rim), alpha
    resized smoothly. `keep`: where the model upscale is needed (an option's region); elsewhere a plain resize."""
    a = rgba[..., 3]
    col = np.where(a[..., None] > 0.9, rgba[..., :3], _fill(rgba[..., :3], (a > 0.9).astype(np.float32)))
    if factor > 1:
        col = upscale.upscale2(np.clip(col, 0, 1), keep)
        a = cv2.resize(a, (col.shape[1], col.shape[0]), interpolation=cv2.INTER_LINEAR)
    # Fully transparent: white (the region editor shows the colours as they are — a spread glow looked like dirt);
    # the soft edge keeps the spread colours (no white fringe once multiplied by the alpha).
    col = np.where((a > 0.004)[..., None], col, 1.0)
    return np.dstack([np.clip(col, 0, 1), np.clip(a, 0, 1)]).astype(np.float32)


def png_b64(rgba: np.ndarray) -> str:
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, "PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode()


def plate_b64(rgba: np.ndarray) -> str:
    """A file's colour plate, lossless (2026-10-30: the JPEG plate looked blurred as the source of "Thêm vào lớp"),
    with its picture's own soft alpha (an opaque plate showed a hard stair-stepped outline on white)."""
    ok, buf = cv2.imencode(".png", cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA), [cv2.IMWRITE_PNG_COMPRESSION, 6])
    if not ok:
        raise HTTPException(500, "không mã hoá được PNG")
    return base64.b64encode(buf.tobytes()).decode()


def jpg_b64(rgb: np.ndarray) -> str:
    ok, buf = cv2.imencode(".jpg", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 92])
    if not ok:
        raise HTTPException(500, "không mã hoá được JPEG")
    return base64.b64encode(buf.tobytes()).decode()


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
    with _quick:
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


class Cancelled(Exception):
    pass


def _check(out_dir: str) -> None:
    """A job its caller deleted (gave up on it) stops at the next picture: queued plans of a set that was asked
    again ran one after the other for hours on the small VPS (2026-10-18)."""
    if os.path.basename(out_dir) not in _jobs:
        raise Cancelled()


async def _run_job(job_id: str, fn, body) -> None:
    try:
        async with _lock:  # one job at a time: a few GB of float arrays
            if job_id not in _jobs:
                return  # deleted while it waited
            result = await asyncio.to_thread(fn, body, _job_dir(job_id))
            if job_id not in _jobs:
                return
            _jobs[job_id] = {"status": "done", "result": result, "at": time.time()}
    except Cancelled:
        log.info("job %s cancelled", job_id)
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

def mask8(img: Image.Image) -> np.ndarray:
    """read_mask as 8-bit (0..255)."""
    if img.mode in ("RGBA", "LA", "PA") or "transparency" in img.info:
        return np.asarray(img.convert("RGBA").getchannel("A")).copy()
    return np.asarray(img.convert("L")).copy()


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
    """The master's own cut-out (gpt-image drew it on a transparent background) at print size."""
    t0 = time.time()
    rgba = transparent_rgba(fetch(body.master), "Master")
    h, w = rgba.shape[:2]
    factor = print_factor(w, h)
    out = print_rgba(rgba, factor)
    log.info("matte (own alpha) %d×%d ×%.0f in %.1fs", w, h, factor, time.time() - t0)
    return {
        "width": out.shape[1],
        "height": out.shape[0],
        "factor": factor,
        "files": {"colour": write_colour(out_dir, "colour.png", out[..., :3]), "alpha": write_mask(out_dir, "alpha.png", out[..., 3])},
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
# customize-tool decides every picture (lib/char-plan.ts): the paper doll and every option drawn on it. Here each
# option is registered onto the doll and upscaled, and its region is what it drew anew (layers.part_region).

class PlanOption(BaseModel):
    key: str               # "<slot>#<index>"
    slot: str
    label: str
    option: str = ""
    index: int = 0
    picture: str           # its picture id ("opt.<slot>.<index>")
    subject: int = 0       # whose part it is (left → right): its region stays on that figure's side of the doll
    url: str
    fine: bool = False     # thin features (eyes, brows, a mouth): small pieces and thin lines are the part
    spread: bool = False   # a part in pieces far apart (a hat + a sweater): every piece on its side is the part
    against: str | None = None  # the picture it is cut against instead of the doll (hair drawn under the hats of
                                # another option picture): its region = what it drew anew on THAT picture


class PlanZone(BaseModel):
    id: str
    label: str = ""
    mask: str              # the zone painted magenta on the doll


class PlanBody(BaseModel):
    doll: str              # the paper doll (transparent): the canvas every file lands on, and the body file
    key: str | None = None # the doll's underwear colour (#rrggbb): never part of an option
    subjects: int = 1      # how many figures the doll has
    options: list[PlanOption] = []
    zones: list[PlanZone] = []


def _plan(body: PlanBody, out_dir: str) -> dict:
    t0 = time.time()
    doll = transparent_rgba(fetch(body.doll), "Búp bê giấy")
    H, W = doll.shape[:2]
    factor = print_factor(W, H)
    size = (round(W * factor), round(H * factor))
    doll_white = on_white(doll[..., :3], doll[..., 3])
    aligns: dict[str, dict] = {}
    checks: list[dict] = []
    pictures: list[dict] = []
    pieces: list[dict] = []
    lands: dict[int, np.ndarray | None] = {}

    def to_print(m: np.ndarray) -> np.ndarray:
        return cv2.resize(m.astype(np.float32), size, interpolation=cv2.INTER_LINEAR) if m.shape[:2] != (size[1], size[0]) else m.astype(np.float32)

    def save_picture(pid: str, label: str, rgba: np.ndarray, keep: np.ndarray | None = None) -> None:
        up = print_rgba(rgba, factor, keep)
        pictures.append({"id": pid, "label": label, "colour": write_colour(out_dir, f"{pid}.colour.png", up[..., :3]), "alpha": write_mask(out_dir, f"{pid}.alpha.png", up[..., 3])})

    def save_region(m: np.ndarray) -> str:
        # Anti-aliased at print size (a binary mask ×2 shows stairs).
        reg = np.clip(cv2.GaussianBlur((to_print(m.astype(np.float32)) > 0.5).astype(np.float32), (0, 0), 0.6 * factor), 0, 1)
        return write_mask(out_dir, f"region.{len(pieces)}.png", reg)

    save_picture("base", "Búp bê giấy", doll)
    # Pictures by url, registered onto the doll once: several options share one picture (a group: every grandchild's
    # hair in one, 2026-10-19), and a picture another option is cut against is needed registered first.
    by_url: dict[str, list[PlanOption]] = {}
    for o in body.options:
        by_url.setdefault(o.url, []).append(o)
    registered: dict[str, np.ndarray] = {}

    def reg_of(url: str, label: str) -> np.ndarray:
        """`url` registered onto the doll (or onto the picture it is cut against)."""
        if url in registered:
            return registered[url]
        opts = by_url.get(url, [])
        rgba = fit(transparent_rgba(fetch(url), label), W, H)
        base = reg_of(opts[0].against, label) if opts and opts[0].against else doll
        subj = {x.subject for x in opts}
        # One subject's picture: its own side guides the registration; a shared one: the whole doll.
        own = lands.setdefault(opts[0].subject, territory(doll[..., 3], opts[0].subject, body.subjects)) if len(subj) == 1 and opts else None
        reg, a = register_option(base, rgba, body.key, own)
        aligns[url] = a
        registered[url] = reg
        del rgba
        return reg

    for url, opts in by_url.items():
        _check(out_dir)
        reg = reg_of(url, opts[0].label)
        a = aligns[url]
        keep_all: np.ndarray | None = None
        # Whose each new pixel is, from the picture itself (layers.shared_lands) — also on one subject's picture: the AI
        # re-draws a neighbour's hair beside the grandma's (2026-10-20: black and blonde locks in her hair file).
        shared: dict[tuple[str, bool], list[np.ndarray] | None] = {}
        for o in opts:
            ref = registered[o.against] if o.against else doll
            own = lands.setdefault(o.subject, territory(doll[..., 3], o.subject, body.subjects))
            if body.subjects > 1:
                sk = (o.against or "", bool(o.fine))
                if sk not in shared:
                    shared[sk] = shared_lands(ref, reg, body.key, body.subjects, bool(o.fine), doll[..., 3])
                own = shared[sk][o.subject] if shared[sk] else own
            m, info = part_region(ref, reg, body.key, own, o.fine, o.spread)
            if m.any():
                k = cv2.dilate(m.astype(np.uint8), kernel(48)).astype(bool)
                keep_all = k if keep_all is None else (keep_all | k)
            ok_align = a["residual"] <= 0.6 and a["before"] <= 4.0
            checks.append({"name": f"Khớp: {o.label}", "ok": ok_align, "detail": f"lệch {a['before']:.2f} → {a['residual']:.2f} px (tệ nhất {a['max']:.2f})" + ("" if ok_align else " — AI dời người khi vẽ: vẽ lại ảnh này"), "piece": o.key})
            ok = info["px"] >= (150 if o.fine else 500) and info["lost"] <= 1500
            detail = f"{info['px']:,} px vẽ mới"
            if info["px"] < (150 if o.fine else 500):
                detail += " — gần như không khác ảnh nền: vẽ lại ảnh này"
            if info["lost"] > 1500:
                detail += f" · AI xoá / dời {info['lost']:,} px của ảnh nền (lớp chỉ thêm được, không bớt được): vẽ lại ảnh này"
            checks.append({"name": f"Vùng {o.label}", "ok": ok, "detail": detail, "piece": o.key})
            pieces.append({"key": o.key, "slot": o.slot, "kind": "part", "label": o.label, "option": o.option, "index": o.index, "picture": o.picture, "region": save_region(m)})
        # Only its regions (with room for a hand fix) are cut from it: the model upscale there, a resize elsewhere.
        save_picture(opts[0].picture, opts[0].label, reg, keep_all)
    # A picture only cut against (never an option itself) is not saved; every registered one is let go.
    registered.clear()
    for z in body.zones:
        paint, a = register(doll_white, fit(rgb_on_white(fetch(z.mask)), W, H))
        aligns[z.mask] = a
        m = region_zone(paint) > 0.5
        ok = int(m.sum()) >= 500
        checks.append({"name": f"Vùng ảnh khách: {z.label or z.id}", "ok": ok, "detail": "" if ok else "AI không tô được — tô vùng bằng tay.", "piece": f"zone:{z.id}"})
        pieces.append({"key": f"zone:{z.id}", "slot": f"zone:{z.id}", "kind": "zone", "label": f"Vùng ảnh khách: {z.label or z.id}", "option": "", "index": 0, "picture": "base", "region": save_region(m)})
    # The body file = the whole doll (the region covers it with room; the editor can erase from it).
    body_region = cv2.dilate((doll[..., 3] > 0.02).astype(np.uint8), kernel(8)).astype(bool)
    pieces.append({"key": "body", "slot": "body", "kind": "body", "label": "Thân", "option": "", "index": 0, "picture": "base", "region": save_region(body_region)})
    log.info("plan: %d options in %.1fs", len(body.options), time.time() - t0)
    return {"width": size[0], "height": size[1], "factor": factor, "pictures": pictures, "pieces": pieces, "checks": checks, "align": aligns}


@app.post("/plan")
async def start_plan(body: PlanBody, authorization: str | None = Header(default=None)) -> dict:
    auth(authorization)
    return _start(_plan, body)


# ---- 3. cut -------------------------------------------------------------------------------------------------

class CutPicture(BaseModel):
    colour: str
    alpha: str


class CutOption(BaseModel):
    name: str
    hex: str | None = None       # color mode: the option's colour (the first is as drawn)
    picture: str | None = None   # its picture (color mode: only the first has one)
    region: str | None = None


class CutColour(BaseModel):
    name: str
    hex: str | None = None


class CutSlot(BaseModel):
    key: str
    label: str
    mode: str                    # shape | texture | color
    wraps: bool = False          # back (the whole part) + front (where it lies on the doll's figure)
    options: list[CutOption]
    colors: list[CutColour] = []
    figure: str | None = None    # wraps: the picture whose figure the front layer lies on (hair drawn over the
                                 # sweaters of an outfit picture); default the doll
    cut_colour: bool = False     # drawn in a cut colour (the slot's cutColor, 2026-10-30): EVERY colour the customer
                                 # picks is a recolour, the first one too


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
    cache: dict[str, tuple[np.ndarray, np.ndarray]] = {}

    # Every picture / region is kept 8-bit until its file is made (layers.unit): as floats, a 63-option set took
    # 11 GB and was OOM-killed (2026-10-19).
    def pic(pid: str) -> tuple[np.ndarray, np.ndarray]:
        if pid not in cache:
            if pid not in body.pictures:
                raise HTTPException(400, f"thiếu ảnh {pid}")
            p = body.pictures[pid]
            col = np.ascontiguousarray(np.asarray(fetch(p.colour).convert("RGB")))
            a = mask8(fetch(p.alpha))
            if a.shape != col.shape[:2]:
                a = cv2.resize(a, (col.shape[1], col.shape[0]), interpolation=cv2.INTER_LINEAR)
            cache[pid] = (col, a)
        return cache[pid]

    b_col, b_a = pic(body.body_picture)
    H, W = b_a.shape

    def region(url: str | None) -> np.ndarray | None:
        if not url:
            return None
        m = mask8(fetch(url))
        return m if m.shape == (H, W) else cv2.resize(m, (W, H), interpolation=cv2.INTER_LINEAR)

    slots: list[Slot] = []
    for s in body.slots:
        slot = Slot(s.key, s.label, s.mode, wraps=s.wraps, colors=[(c.name, c.hex) for c in s.colors], hexes=[o.hex for o in s.options], cut_colour=s.cut_colour)
        if s.figure:
            slot.figure = pic(s.figure)[1]
            slot.ref_piece = next((f"{h.key}#{i}" for h in body.slots for i, ho in enumerate(h.options) if ho.picture == s.figure), None)
        for o in s.options:
            opt = Option(o.name)
            if o.picture:
                opt.col, opt.alpha = pic(o.picture)
                opt.region = region(o.region)
            slot.options.append(opt)
        slots.append(slot)
    zones = [Zone(z.id, region(z.region)) for z in body.zones]
    out = cut(unit(b_col), unit(b_a) * unit(region(body.body_region)), slots, zones, lambda rgba: (png_b64(rgba), bbox(rgba)), plate_b64)
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
        "files": [{"slot": f.slot, "label": f.label, "option": f.option, "color": f.color, "piece": f.piece, "png": f.png, "bbox": f.bbox, "plate": f.plate} for f in out["files"]],
        # Each file's colours over the whole canvas (PNG): what a hand edit adds to the file is painted from these.
        "plates": out["plates"],
        # A part made of a back + a front layer as it is seen (its whole back file): the option's thumbnail.
        "views": [{"slot": v.slot, "option": v.option, "color": v.color, "png": v.png, "plate": v.plate} for v in out["views"]],
    }


@app.post("/cut")
async def start_cut(body: CutBody, authorization: str | None = Header(default=None)) -> dict:
    auth(authorization)
    return _start(_cut, body)
