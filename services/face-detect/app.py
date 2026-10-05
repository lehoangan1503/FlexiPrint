"""
face-detect — find the face in a customer photo and crop to it.

The "Face" photo styles of a photo zone (customize-tool lib/photo-styles.ts)
send the customer's photo here first; the app then cuts the crop out of its
background (bg-remover) and the browser applies the colour filter.

Detectors, tried in order (all CPU, all bundled with / downloaded by OpenCV —
no paid API):
    face     YuNet (OpenCV DNN, models/face_detection_yunet_2023mar.onnx) —
             people, and often dogs too
    cat      Haar cascade frontalcatface(_extended), shipped with opencv
A person's head is then cut by face PARSING (BiSeNet / CelebAMask-HQ,
models/face_parsing_resnet18.onnx, MIT): skin, features, ears and hair kept —
neck, clothes and background dropped — so the outline is the person's own
(hair hanging beside the cheeks stays, the chin is the real jaw line).
Pets have no parsing model: their outline is drawn from the eyes (PROFILES).
Nothing found → 422 "no face"; the app may then ask an LLM for the box and
call /crop again with `box=` (detection skipped).

    POST /detect   multipart `file` → {"width", "height", "faces": [{"x","y","w","h","score","kind"}]}  (px, biggest first)
    POST /crop     multipart `file` — send the cut-out (bg-remover output) for a clean head, its
                   alpha is kept. Optional `photo` = the original photo: its pixels are used (at its
                   own, full resolution) under the cut-out's alpha, so a matting model that works at a
                   lower size never costs detail. Optional `box` "x,y,w,h", `eyes` "x1,y1,x2,y2", `chin` "x,y"
                   (0–1 fractions) = a face the caller located (detection skipped).
                   query: shape=face (default: head outline down to the chin) | box
                   → image/png (RGBA): the head turned UPRIGHT (eye line level), trimmed, at the photo's
                   own resolution (never scaled down) — its outline is the subject's own edge (hair,
                   ears, fur), cut only under the chin;
                   headers X-Face-Box, X-Face-Kind, X-Face-Roll (degrees, or "none" = unknown)
                   422 when no face is found
    GET  /health

Env: FD_TOKEN (Bearer), FD_MAX_BYTES (15 MB), FD_MAX_SIDE (4096), FD_MIN_SCORE (0.7)
"""

from __future__ import annotations

import io
import logging
import os
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.responses import Response
from PIL import Image, ImageOps, UnidentifiedImageError

TOKEN = os.getenv("FD_TOKEN", "")
MAX_BYTES = int(os.getenv("FD_MAX_BYTES", str(15 * 1024 * 1024)))
MAX_SIDE = int(os.getenv("FD_MAX_SIDE", "4096"))
MIN_SCORE = float(os.getenv("FD_MIN_SCORE", "0.7"))
# Detection runs on a downscaled copy: faster, and YuNet is trained around this size.
DETECT_SIDE = 640

MODEL_DIR = Path(__file__).parent / "models"
YUNET = MODEL_DIR / "face_detection_yunet_2023mar.onnx"
YUNET_URL = "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
PARSER = MODEL_DIR / "face_parsing_resnet18.onnx"
PARSER_URL = "https://github.com/yakhyo/face-parsing/releases/download/weights/resnet18.onnx"

log = logging.getLogger("face-detect")
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")


def _model(path: Path, url: str) -> str:
    if not path.exists():
        MODEL_DIR.mkdir(exist_ok=True)
        log.info("downloading %s", url)
        tmp = path.with_suffix(".part")
        urllib.request.urlretrieve(url, tmp)
        tmp.rename(path)
    return str(path)


YUNET_PATH = _model(YUNET, YUNET_URL)
try:
    # ~50 MB; without it people fall back to the drawn outline (like pets).
    PARSER_NET: cv2.dnn.Net | None = cv2.dnn.readNetFromONNX(_model(PARSER, PARSER_URL))
except Exception as e:  # noqa: BLE001 — offline first start, corrupt download
    log.warning("face parsing unavailable (%s): people get the drawn outline", e)
    PARSER_NET = None
CAT_CASCADES = [cv2.CascadeClassifier(cv2.data.haarcascades + n) for n in ("haarcascade_frontalcatface_extended.xml", "haarcascade_frontalcatface.xml")]
EYE_CASCADE = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_eye.xml")

app = FastAPI(title="face-detect")


@dataclass
class Face:
    """A face box in photo px, plus what is known about its pose."""

    x: float
    y: float
    w: float
    h: float
    score: float
    kind: str
    # Eye centres in photo px (order free). None = unknown (a cat whose eyes the cascade missed).
    eyes: tuple[tuple[float, float], tuple[float, float]] | None = None
    # Chin point in photo px, or the mouth centre (`mouth=True`, YuNet). None = estimate from the eyes.
    chin: tuple[float, float] | None = None
    mouth: bool = False

    def area(self) -> float:
        return self.w * self.h

    def centre(self) -> tuple[float, float]:
        return self.x + self.w / 2, self.y + self.h / 2

    @property
    def roll(self) -> float | None:
        """Head tilt: angle of the eye line in degrees (image y down, so + = clockwise). None = unknown."""
        if self.eyes is None:
            return None
        (x1, y1), (x2, y2) = sorted(self.eyes)
        return float(np.degrees(np.arctan2(y2 - y1, x2 - x1)))


def _read(data: bytes) -> Image.Image:
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except (UnidentifiedImageError, OSError) as e:
        raise HTTPException(400, "Not a readable PNG/JPEG/WebP image") from e
    # Phone photos carry their rotation in EXIF. A cut-out (bg-remover ran first) keeps its alpha.
    img = ImageOps.exif_transpose(img)
    img = img.convert("RGBA" if img.mode in ("RGBA", "LA", "PA") or "transparency" in img.info else "RGB")
    if max(img.size) > MAX_SIDE:
        img.thumbnail((MAX_SIDE, MAX_SIDE), Image.Resampling.LANCZOS)
    return img


def detect(img: Image.Image) -> list[Face]:
    """Faces in `img` pixels, biggest first, with eyes (and mouth) when the detector finds them."""
    k = min(1.0, DETECT_SIDE / max(img.size))
    small = img.resize((max(1, round(img.width * k)), max(1, round(img.height * k)))) if k < 1 else img
    if small.mode == "RGBA":
        # Detectors want an opaque photo: a cut-out goes on white.
        flat = Image.new("RGB", small.size, (255, 255, 255))
        flat.paste(small, mask=small.getchannel("A"))
        small = flat
    bgr = cv2.cvtColor(np.asarray(small), cv2.COLOR_RGB2BGR)
    faces: list[Face] = []

    # A new detector per call: FaceDetectorYN holds the input size, and requests run in threads.
    yunet = cv2.FaceDetectorYN.create(YUNET_PATH, "", (bgr.shape[1], bgr.shape[0]), MIN_SCORE, 0.3, 50)
    _, found = yunet.detect(bgr)
    for f in found if found is not None else []:
        # Landmarks: right eye, left eye, nose, right / left mouth corner.
        faces.append(
            Face(
                f[0] / k, f[1] / k, f[2] / k, f[3] / k, float(f[-1]), "face",
                eyes=((f[4] / k, f[5] / k), (f[6] / k, f[7] / k)),
                chin=((f[10] + f[12]) / 2 / k, (f[11] + f[13]) / 2 / k),
                mouth=True,
            )
        )

    if not faces:
        gray = cv2.equalizeHist(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY))
        min_side = max(24, min(gray.shape) // 10)
        for cascade in CAT_CASCADES:
            for x, y, w, h in cascade.detectMultiScale(gray, scaleFactor=1.05, minNeighbors=4, minSize=(min_side, min_side)):
                face = Face(x / k, y / k, w / k, h / k, 0.0, "cat")
                # Eyes in the face's upper half → the tilt.
                upper = gray[y : y + h * 2 // 3, x : x + w]
                eyes = EYE_CASCADE.detectMultiScale(upper, scaleFactor=1.05, minNeighbors=3, minSize=(max(6, w // 10), max(6, w // 10)), maxSize=(w // 2, w // 2))
                if len(eyes) >= 2:
                    a, b = sorted(eyes, key=lambda e: e[2] * e[3], reverse=True)[:2]
                    face.eyes = (((x + a[0] + a[2] / 2) / k, (y + a[1] + a[3] / 2) / k), ((x + b[0] + b[2] / 2) / k, (y + b[1] + b[3] / 2) / k))
                faces.append(face)
            if faces:
                break
    return sorted(faces, key=Face.area, reverse=True)


# ---------------------------------------------------------------------------
# The head
# ---------------------------------------------------------------------------
#
# Everything is measured in EYE DISTANCES (d) from the eye midpoint, in the
# upright head (eye line level, y down) — eyes are what every locator (YuNet,
# the cat cascade's eye pass, an LLM) gets right; face boxes vary wildly
# between them (brow-to-mouth, whole face, half the body).
#
# The FACE, not the whole head: ears, forehead, cheeks, muzzle, chin — no neck,
# no body, no hair down the back. Two halves meet on the eye line:
#   above  a squarish superellipse (|x/rx|^n + |y/top|^n ≤ 1): ear tips sit
#          wide AND high, which a plain ellipse cuts off
#   below  the jaw: half-widths at fractions of the eye → chin distance,
#          following the cheeks in to a rounded chin — not a wide bowl, which
#          dragged the neck in beside the chin
# On a cut-out (alpha from bg-remover) the outline then follows the subject's
# own edge — the ears and fur come out whole — and only the jaw is a drawn
# line. The part connected to the face is kept, so a paw or a second pet
# inside the outline drops out.
#
# PEOPLE skip the drawn outline: face parsing labels every pixel (skin, eyes,
# brows, nose, lips, ears, hair, hat vs neck, clothes, background), so the
# head comes out the way it really is — hair falling beside the cheeks kept,
# the chin on the real jaw line, no neck, no shirt. Pets keep the outline:
# there is no parsing model for them.


@dataclass(frozen=True)
class Profile:
    """Face proportions, in eye distances (d) from the eye midpoint."""

    rx: float  # half-width above the eye line (ears / temples)
    top: float  # eye line → top of the ears / forehead
    n: float  # squareness of the top half
    jaw: tuple[float, float, float, float]  # half-widths at 0, 0.3, 0.6, 0.8 of the way to the chin
    chin: float  # eye line → chin when no chin point is known
    chin_range: tuple[float, float]  # plausible eye line → chin: an LLM chin is clamped into it


PROFILES = {
    # People (YuNet / LLM "person"): forehead + hairline, ears; the chin from the mouth landmark.
    "face": Profile(1.35, 1.9, 2.4, (1.35, 1.3, 1.1, 0.8), 2.0, (1.6, 2.5)),
    # Cats: tall ears set wide, cheeks narrowing to a short muzzle.
    # The chin sits well under the mouth (an LLM chin often lands ON the mouth: the range's floor keeps
    # the lower lip and chin), and the jaw narrows fast — the fur beside the throat is not the face.
    "cat": Profile(1.65, 2.4, 3.0, (1.5, 1.3, 0.95, 0.65), 1.7, (1.65, 1.8)),
    # Dogs: long muzzle, ears often hanging beside the jaw.
    "dog": Profile(1.75, 2.3, 2.6, (1.7, 1.55, 1.25, 0.9), 1.8, (1.3, 2.6)),
    # Anything else an LLM located.
    "given": Profile(1.7, 2.4, 2.8, (1.65, 1.45, 1.15, 0.8), 1.5, (1.15, 2.2)),
}
JAW_T = np.array([0.0, 0.3, 0.6, 0.8], dtype=np.float32)
# Without alpha (the cut-out failed) the outline IS the edge: tighter, so less background comes along.
OPAQUE_SHRINK = (0.88, 0.75)  # × rx, × top
FEATHER = 2.0  # px, soft edge of the drawn (jaw) line


def _eye_frame(face: Face) -> tuple[float, float, float, float]:
    """Eye midpoint (x, y), eye distance d (px) and roll (degrees)."""
    if face.eyes is not None:
        (x1, y1), (x2, y2) = face.eyes
        d = float(np.hypot(x2 - x1, y2 - y1))
        if d > face.w * 0.15:
            return (x1 + x2) / 2, (y1 + y2) / 2, d, face.roll or 0.0
    # No (usable) eyes: the cascade's box spans the face below the ears, eyes ~0.42 down.
    cx, _ = face.centre()
    return cx, face.y + face.h * 0.42, face.w * 0.42, 0.0


def _chin(face: Face, mx: float, my: float, d: float, roll: float) -> float:
    """Eye line → chin, px along the face's down axis."""
    prof = PROFILES.get(face.kind, PROFILES["given"])
    default = prof.chin * d
    if face.chin is None:
        return default
    t = np.radians(roll)
    vx, vy = face.chin[0] - mx, face.chin[1] - my
    down = -vx * np.sin(t) + vy * np.cos(t)
    side = vx * np.cos(t) + vy * np.sin(t)
    if face.mouth:
        # Eye → mouth ≈ 0.57 of eye → chin on a human face.
        down = down * 1.75
    # A chin beside the face is no chin: trust the proportions.
    if abs(side) > 0.8 * d or down <= 0:
        return default
    lo, hi = prof.chin_range
    # LLM chins land anywhere from the lip line to the chest fur: the range keeps the lower mouth and drops the chest.
    return float(np.clip(down * (1.0 if face.mouth else 1.03), lo * d, hi * d))


# Face parsing (CelebAMask-HQ labels): what a person's head is made of.
PARSE_SIZE = 512
PARSE_KEEP = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 17, 18]  # skin, brows, eyes, glasses, ears, earrings, nose, mouth, lips, hair, hat
# (dropped: 0 background, 14 neck, 15 necklace, 16 clothes)
# The parser sees a square around the head like its training crops: 5.8 eye distances wide, eyes 42 % down
# (room for the hair on top and ~1.3 d of it under the chin).
PARSE_SIDE, PARSE_EYES = 5.8, 0.42
# Person crop, in eye distances: wide and tall enough for hair; hair hanging past the chin fades out between these.
PERSON_HALF, PERSON_TOP, HAIR_FADE = 2.4, 2.8, (0.8, 1.3)
# A person's eyes + nose are skin / features to the parser: less than this there is no human face (a pet YuNet fired on).
PARSE_MIN_CORE = 0.75


def _parse_head(work: Image.Image, ox: float, oy: float, d: float) -> np.ndarray | None:
    """P(head) per pixel of `work` (upright, eye midpoint at ox, oy): soft, from the parser's own scores."""
    if PARSER_NET is None:
        return None
    side = max(16, int(round(PARSE_SIDE * d)))
    x0, y0 = int(round(ox - side / 2)), int(round(oy - PARSE_EYES * side))
    # The photo's own pixels, even where the cut-out made them transparent: the parser wants context.
    win = Image.new("RGB", (side, side), (128, 128, 128))
    win.paste(work.convert("RGB"), (-x0, -y0))
    x = np.asarray(win.resize((PARSE_SIZE, PARSE_SIZE), Image.Resampling.BILINEAR), dtype=np.float32) / 255.0
    x = (x - np.array([0.485, 0.456, 0.406], dtype=np.float32)) / np.array([0.229, 0.224, 0.225], dtype=np.float32)
    PARSER_NET.setInput(x.transpose(2, 0, 1)[None].astype(np.float32))
    logits = PARSER_NET.forward()[0]
    e = np.exp(logits - logits.max(axis=0, keepdims=True))
    keep = e[PARSE_KEEP].sum(axis=0) / e.sum(axis=0)
    # Hardened around 0.5 (a crisp edge), blurred back a touch when scaled up to the photo.
    keep = np.clip((keep - 0.5) * 4 + 0.5, 0, 1).astype(np.float32)
    up = cv2.resize(keep, (side, side), interpolation=cv2.INTER_LINEAR)
    full = np.zeros((work.height, work.width), dtype=np.float32)
    fx0, fy0, fx1, fy1 = max(0, x0), max(0, y0), min(work.width, x0 + side), min(work.height, y0 + side)
    if fx1 > fx0 and fy1 > fy0:
        full[fy0:fy1, fx0:fx1] = up[fy0 - y0 : fy1 - y0, fx0 - x0 : fx1 - x0]
    return full


# The head's own centre line, read from the cut-out across the cheeks (eye line → AXIS_BAND[1] d below), may sit
# at most AXIS_MAX_SHIFT d beside the eye midpoint: located eyes are often a few % off, and an outline centred on
# them came out lopsided — one cheek whole, the other cut.
AXIS_BAND, AXIS_MAX_SHIFT = (-0.2, 0.6), 0.45


def _head_axis(alpha: np.ndarray, inside: np.ndarray, ox: int, oy: int, d: float, rx: float) -> float:
    """
    Horizontal offset (px) of the head's centre from the eye midpoint (ox, oy) in an upright cut-out; 0 = unknown.
    `inside`: True where the photo is — a run ending at the photo's own border is no cheek edge.
    """
    lefts, rights = [], []
    for y in range(max(0, int(oy + AXIS_BAND[0] * d)), min(alpha.shape[0], int(oy + AXIS_BAND[1] * d))):
        row = alpha[y] > 128
        if not row[ox]:
            continue
        # The opaque run through the face's middle: the cheek edges on both sides.
        gaps = np.flatnonzero(~row)
        l_gap, r_gap = gaps[gaps < ox], gaps[gaps > ox]
        if not l_gap.size or not r_gap.size or not inside[y, l_gap[-1]] or not inside[y, r_gap[0]]:
            continue
        lefts.append(ox - l_gap[-1] - 1)
        rights.append(r_gap[0] - ox)
    if len(lefts) < 3:
        return 0.0
    lw, rw = float(np.median(lefts)), float(np.median(rights))
    # Wider than the outline on a side: fur / body / background runs on there, no edge to read.
    if lw > rx * 1.1 or rw > rx * 1.1:
        return 0.0
    return float(np.clip((rw - lw) / 2, -AXIS_MAX_SHIFT * d, AXIS_MAX_SHIFT * d))


def _drawn_outline(prof: Profile, xs: np.ndarray, ys: np.ndarray, ox: float, oy: float, rx: float, top: float, jaw: np.ndarray, chin: float) -> np.ndarray:
    """0–1 inside the drawn face outline (PROFILES): superellipse above the eye line, the jaw below."""
    u, v = np.abs(xs - ox), ys - oy
    # ≈ px outside the outline (negative inside).
    q = (u / rx) ** prof.n + (np.maximum(-v, 0) / top) ** prof.n
    dist_top = (q ** (1 / prof.n) - 1) * min(rx, top)
    t = np.clip(v / chin, 0, None)
    width = np.interp(np.minimum(t, 0.8), JAW_T, jaw)
    # The last fifth rounds into the chin.
    end = np.clip((t - 0.8) / 0.2, 0, 1)
    width = width * np.sqrt(np.clip(1 - end**2, 0, 1))
    dist_jaw = np.where(t <= 1, u - width, np.maximum(u, (v - chin)))
    dist = np.where(v < 0, dist_top, dist_jaw)
    return np.clip(0.5 - dist / FEATHER, 0, 1)


def upright_head(img: Image.Image, face: Face, shape: str) -> Image.Image:
    """
    The face, turned upright (eye line level) and cut out: a person by face
    parsing, anything else by the drawn outline (PROFILES). Pixels stay at the
    photo's own resolution — nothing is scaled. Outside the photo is
    transparent; the result is trimmed to what is left.
    shape="box": the plain upright rectangle around the face, no outline.
    """
    mx, my, d, roll = _eye_frame(face)
    chin = _chin(face, mx, my, d, roll)
    has_alpha = img.mode == "RGBA" and img.getchannel("A").getextrema()[0] < 250
    prof = PROFILES.get(face.kind, PROFILES["given"])
    parsed = face.kind == "face" and PARSER_NET is not None and shape == "face"
    kx, kt = (1.0, 1.0) if has_alpha else OPAQUE_SHRINK
    rx, top = prof.rx * d * kx, prof.top * d * kt
    jaw = np.array(prof.jaw, dtype=np.float32) * d * kx
    half = max(rx, float(jaw.max()))
    below = chin
    if parsed:
        # Room for the hair: it decides the outline, not the drawn shape.
        half, top, below = max(half, PERSON_HALF * d), max(top, PERSON_TOP * d), chin + HAIR_FADE[1] * d

    # A padded square around the eye midpoint (big enough for the parser's window too), so turning it never pulls in empty corners.
    r = int(np.ceil(max(half, top, below, PARSE_SIDE * d * 0.6 if parsed else 0) * 1.45)) + 4
    work = Image.new("RGBA", (2 * r, 2 * r), (0, 0, 0, 0))
    work.paste(img.convert("RGBA"), (round(r - mx), round(r - my)))
    if roll:
        # PIL turns counter-clockwise for a positive angle: that levels a clockwise-tilted eye line.
        work = work.rotate(roll, resample=Image.Resampling.BICUBIC, center=(r, r))
    # Pets: the outline is centred on the head itself, not on the (located) eyes.
    sx = 0
    if has_alpha and not parsed:
        inside = Image.new("L", (2 * r, 2 * r), 0)
        inside.paste(255, (round(r - mx), round(r - my), round(r - mx) + img.width, round(r - my) + img.height))
        if roll:
            inside = inside.rotate(roll, resample=Image.Resampling.NEAREST, center=(r, r))
        sx = int(round(_head_axis(np.asarray(work.getchannel("A")), np.asarray(inside) > 0, r, r, d, rx)))
    left, upper, right, lower = r + sx - int(half) - 2, r - int(top) - 2, r + sx + int(half) + 2, r + int(below) + 3
    if shape == "box":
        out = work.crop((left, upper, right, lower))
        bbox = out.getchannel("A").getbbox()
        return out.crop(bbox) if bbox else out

    head = _parse_head(work, r, r, d) if parsed else None
    out = work.crop((left, upper, right, lower))
    a = np.asarray(out.getchannel("A"), dtype=np.float32)
    h, w = a.shape
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    ox, oy = r - left, r - upper  # the eye midpoint in `out`
    core = (xs - ox) ** 2 + (ys - (oy + 0.35 * d)) ** 2 < d * d
    cx = ox + sx  # the head's centre line: the drawn outline's axis
    if head is not None and float(head[upper:lower, left:right][core].mean()) < PARSE_MIN_CORE:
        # YuNet fires on pets too: the parser then finds no human face at the eyes + nose. Cut it like a pet.
        log.info("parsing found no face at the eyes (%.2f): drawn outline", float(head[upper:lower, left:right][core].mean()))
        head, prof = None, PROFILES["given"]
        rx, top = prof.rx * d * kx, prof.top * d * kt
        jaw = np.array(prof.jaw, dtype=np.float32) * d * kx
    if head is not None:
        region = head[upper:lower, left:right]
        # Long hair: kept beside the cheeks, faded out under the chin instead of running down the back.
        v = ys - oy - chin
        region = region * np.clip(1 - (v - HAIR_FADE[0] * d) / ((HAIR_FADE[1] - HAIR_FADE[0]) * d), 0, 1)
        # No cut-out: the parser's edge is the edge.
        alpha = (a if has_alpha else np.full_like(a, 255)) * region
    else:
        alpha = a * _drawn_outline(prof, xs, ys, cx, oy, rx, top, jaw, chin)

    if has_alpha or head is not None:
        # Keep the blob joined to the face: a paw, a toy, a second pet / person inside the outline drops out.
        solid = (alpha > 96).astype(np.uint8)
        n, labels = cv2.connectedComponents(solid, connectivity=8)
        if n > 2:
            # The face's own pixels: the component with most area inside `core` (a disc of radius d at the eyes + nose).
            counts = np.bincount(labels[core & (solid > 0)], minlength=n)
            counts[0] = 0
            keep = int(counts.argmax()) if counts.max() > 0 else int(np.bincount(labels[solid > 0]).argmax())
            mask = (labels == keep).astype(np.uint8)
            # Grow by 2 px so the matte's soft edge around the blob stays.
            mask = cv2.dilate(mask, np.ones((5, 5), np.uint8))
            alpha *= mask

    out.putalpha(Image.fromarray(np.clip(alpha, 0, 255).astype(np.uint8)))
    bbox = out.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
    return out.crop(bbox) if bbox else out


def _with_photo(cut: Image.Image, photo: Image.Image) -> Image.Image:
    """The original photo's pixels (full resolution) under the cut-out's alpha, scaled up to it."""
    rgb = photo.convert("RGB")
    if cut.mode != "RGBA":
        return rgb
    alpha = cut.getchannel("A")
    if alpha.size != rgb.size:
        alpha = alpha.resize(rgb.size, Image.Resampling.BICUBIC)
    out = rgb.convert("RGBA")
    out.putalpha(alpha)
    return out


def _authorize(authorization: str | None) -> None:
    if TOKEN and authorization != f"Bearer {TOKEN}":
        raise HTTPException(401, "Unauthorized")


async def _upload(file: UploadFile) -> bytes:
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(413, f"File too large (max {MAX_BYTES // (1024 * 1024)} MB)")
    return data


def _floats(raw: str, n: int, what: str) -> list[float]:
    try:
        vals = [float(v) for v in raw.split(",")]
    except ValueError as e:
        raise HTTPException(400, f"{what}: {n} comma-separated 0–1 fractions") from e
    if len(vals) != n or not all(0 <= v <= 1 for v in vals):
        raise HTTPException(400, f"{what}: {n} comma-separated 0–1 fractions")
    return vals


def _given(img: Image.Image, box: str, eyes: str, chin: str, kind: str = "") -> Face:
    """A face the caller located (an LLM): box x,y,w,h; optional eyes x1,y1,x2,y2 and chin x,y — 0–1 fractions; kind cat | dog | face."""
    x, y, w, h = _floats(box, 4, "box")
    if w <= 0 or h <= 0:
        raise HTTPException(400, "box: empty")
    W, H = img.width, img.height
    face = Face(x * W, y * H, w * W, h * H, 1.0, kind if kind in PROFILES else "given")
    if eyes.strip():
        x1, y1, x2, y2 = _floats(eyes, 4, "eyes")
        face.eyes = ((x1 * W, y1 * H), (x2 * W, y2 * H))
        if chin.strip():
            c = _floats(chin, 2, "chin")
            face.chin = (c[0] * W, c[1] * H)
    return face


@app.get("/health")
async def health() -> dict[str, object]:
    return {"status": "ok", "detectors": ["yunet", "cat-haar"], "parsing": PARSER_NET is not None}


@app.post("/detect")
async def detect_faces(file: UploadFile = File(...), authorization: str | None = Header(None)) -> dict[str, object]:
    _authorize(authorization)
    img = _read(await _upload(file))
    faces = detect(img)
    return {"width": img.width, "height": img.height, "faces": [{**f.__dict__, "roll": f.roll} for f in faces]}


@app.post("/crop")
async def crop_face(
    file: UploadFile = File(...),
    photo: UploadFile | None = File(None),
    box: str = Form(""),
    eyes: str = Form(""),
    chin: str = Form(""),
    kind: str = Form(""),
    shape: str = Query("face", pattern="^(face|box)$", description="face = head outline down to the chin (no neck / body); box = the plain rectangle"),
    authorization: str | None = Header(None),
) -> Response:
    _authorize(authorization)
    img = _read(await _upload(file))
    if photo is not None:
        # The cut-out may come back smaller than the photo (matting runs at ~1–2K): its alpha, the photo's pixels.
        img = _with_photo(img, _read(await _upload(photo)))
    face = _given(img, box, eyes, chin, kind) if box.strip() else next(iter(detect(img)), None)
    if face is None:
        raise HTTPException(422, "No face found in the photo")
    out = upright_head(img, face, shape)
    buf = io.BytesIO()
    out.save(buf, format="PNG", compress_level=6)
    log.info("crop %s roll=%s chin=%s %dx%d → %dx%d", face.kind, face.roll, face.chin, img.width, img.height, out.width, out.height)
    return Response(
        buf.getvalue(),
        media_type="image/png",
        headers={
            "X-Face-Box": f"{face.x:.0f},{face.y:.0f},{face.w:.0f},{face.h:.0f}",
            "X-Face-Kind": face.kind,
            # "none": the tilt is unknown (a cat without detectable eyes) — the caller may locate the eyes and retry.
            "X-Face-Roll": "none" if face.roll is None else f"{face.roll:.1f}",
            "Cache-Control": "no-store",
        },
    )
