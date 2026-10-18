"""
Free print upscale (no API): Real-ESRGAN realesr-animevideov3 (BSD-3, xinntao/Real-ESRGAN, 2.5 MB) on CPU via
spandrel. Made for cartoon / line art: sharp outlines, flat fills kept flat. ~9 s for a 1536×1024 picture on 4 cores.

The image models hand back ~1–1.5 K pictures (gpt-image: 1536×1024); the layer set is cut on an upscaled canvas so
a print has ≈ 300 dpi at ~20–25 cm. The model is a deterministic, local convolution: the same input pixels give the
same output pixels, so the master and its in-place edits stay registered after it.
"""

from __future__ import annotations

import logging
import os
import threading

import cv2
import numpy as np

WEIGHTS = os.getenv("UPSCALE_WEIGHTS", os.path.join(os.path.dirname(__file__), "weights", "realesr-animevideov3.pth"))
TILE = 512
PAD = 16

log = logging.getLogger("layer-kit")
_model = None
_lock = threading.Lock()


def available() -> bool:
    return os.path.isfile(WEIGHTS)


def _load():
    global _model
    with _lock:
        if _model is None:
            import torch
            from spandrel import ModelLoader

            torch.set_num_threads(max(1, int(os.getenv("UPSCALE_THREADS", str(os.cpu_count() or 4)))))
            _model = ModelLoader().load_from_file(WEIGHTS).model.eval()
            log.info("upscaler loaded: %s", os.path.basename(WEIGHTS))
    return _model


def upscale2(rgb: np.ndarray, keep: np.ndarray | None = None) -> np.ndarray:
    """RGB float 0–1 → exactly 2×. The model works at 4×; every tile is brought down to 2× right away (area), so the
    memory stays ~2× the picture (the VPS has 1.6 GB) and the tiling is the same for every picture of a set.
    `keep` (bool, input size): only the tiles that touch it go through the model — the same grid, so their pixels are
    exactly those of a full run — the others are resized (bicubic). An option picture is only cut where it drew anew:
    the full run took ~2 min a picture on the 2-core VPS, 60+ pictures over two hours (2026-10-18)."""
    import torch

    h, w = rgb.shape[:2]
    m = _load()
    out = np.zeros((h * 2, w * 2, 3), np.float32)
    with torch.inference_mode():
        for y0 in range(0, h, TILE):
            for x0 in range(0, w, TILE):
                ya, xa = max(0, y0 - PAD), max(0, x0 - PAD)
                yb, xb = min(h, y0 + TILE + PAD), min(w, x0 + TILE + PAD)
                if keep is not None and not keep[ya:yb, xa:xb].any():
                    o = cv2.resize(rgb[ya:yb, xa:xb], ((xb - xa) * 2, (yb - ya) * 2), interpolation=cv2.INTER_CUBIC)
                else:
                    inp = torch.from_numpy(np.ascontiguousarray(rgb[ya:yb, xa:xb].transpose(2, 0, 1))[None])
                    o = m(inp)[0].numpy().transpose(1, 2, 0)
                    o = cv2.resize(o, ((xb - xa) * 2, (yb - ya) * 2), interpolation=cv2.INTER_AREA)
                oy, ox = (y0 - ya) * 2, (x0 - xa) * 2
                hh, ww = min(TILE, h - y0) * 2, min(TILE, w - x0) * 2
                out[y0 * 2:y0 * 2 + hh, x0 * 2:x0 * 2 + ww] = o[oy:oy + hh, ox:ox + ww]
    return np.clip(out, 0, 1)
