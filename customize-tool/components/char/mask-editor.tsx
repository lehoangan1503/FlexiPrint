"use client";

/**
 * Full-screen editor of one layer's region on its picture (the cut, server/char/cut.ts). The master's backdrop has
 * its own point editor (matte-fix.tsx). The mask is a canvas the size of the picture (white, alpha = the mask)
 * and every tool adds to it or takes from it:
 *   Cọ       brush (size, hardness) — a click is a dot
 *   Vùng     lasso: draw round an area, it is filled
 *   Đũa thần magic wand on the picture's colours (tolerance, contiguous or everywhere) — like Photoshop
 *   Mảng     a whole island of the mask (remove a stray bit) / a whole hole inside it (fill)
 *   Làm mịn  softens the cut edge under the brush (a hard, stair-stepped edge looked sharp against the next clipart —
 *            asked 2026-10-12); "Làm mịn cả viền" does the whole edge. It only fades the edge inwards, never adds
 *            pixels (added pixels take the plate's colours, white outside the figure).
 *   Tay      pan (also: hold Space, or the middle button); wheel / pinch = zoom (the browser's own zoom is held off
 *            while the editor is open)
 * Thêm / Bớt switches what a tool does (hold Alt for the other one); Bớt first. Undo / redo (Ctrl+Z / Ctrl+Shift+Z)
 * keep the changed rectangle only, so a long session stays light. "Lưu" sends the mask as PNG; the server keeps 5
 * versions. The tools sit in a column on the left, each with its key.
 *
 * Pictures come from the storage domain with CORS (crossOrigin) — the wand reads the picture's pixels.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Brush, Droplets, Hand, History, Lasso, Loader2, Minus, Move, Plus, Redo2, RotateCcw, Save, Sparkles, Undo2, Wand2, X } from "lucide-react";
import { CHECKER_STYLE, CtButton, cx } from "../ui";

type Tool = "brush" | "lasso" | "wand" | "island" | "smooth" | "move" | "hand";
type Op = "add" | "remove";
type View = "result" | "overlay";

interface Patch {
  x: number;
  y: number;
  before: ImageData;
  after: ImageData;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface MaskEditorProps {
  title: string;
  hint?: string;
  width: number;
  height: number;
  /** The picture (opaque colours at print size). */
  colourUrl: string;
  /** The mask now (PNG: white, alpha = the mask). */
  maskUrl: string;
  /** The picture's subject alpha — the result view shows region × subject (what the file will be). */
  subjectUrl?: string | null;
  /** Highlight colour. */
  tint?: string;
  /** Other regions on the same picture, shown faintly for context. */
  others?: Array<{ url: string; color: string; label: string }>;
  canRevert: boolean;
  readOnly?: boolean;
  /** `png`: the new mask (null when only moved); `move`: whole px the clipart was dragged (null when not moved). */
  onSave: (png: string | null, move: { dx: number; dy: number } | null) => Promise<void>;
  onRevert: () => Promise<void>;
  onClose: () => void;
  /** Opened from one clipart: show the clipart itself ("Kết quả" — region × picture on the checker, the picture
   * faint behind for what is missing) zoomed onto it, not the whole picture it is cut from (asked 2026-10-12). */
  focusPiece?: boolean;
  /** The rest of the outfit on the same canvas, in stacking order — shown dimmed and dark behind the clipart, which
   * keeps its full brightness (asked 2026-10-14). `moves`: the clipart's other half (its back), dragged with it. */
  context?: Array<{ url: string; moves: boolean }>;
  /** Where the clipart itself lies in `context` (its index there): the live preview stacks it there. */
  selfAt?: number;
  /** The "Di chuyển" tool: the clipart (and its other half) can be dragged to a new place. */
  movable?: boolean;
  /** Below the tools (the set's cliparts): `leave(go)` runs `go` once what is unsaved here is saved (or there is none). */
  sidebar?: (leave: (go: () => void) => void) => ReactNode;
}

/** The brush's ring: a white ring with a wide white glow — seen on dark and light pixels alike (2026-10-23: the dark
 * shadow made it vanish on the dark checker). */
export const BRUSH_RING = "pointer-events-none absolute left-0 top-0 z-10 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.55),0_0_10px_3px_rgba(255,255,255,0.9),inset_0_0_6px_1px_rgba(255,255,255,0.6)]";

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("Không tải được ảnh"));
    im.src = src;
  });
}

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

const ctx2d = (c: HTMLCanvasElement) => c.getContext("2d", { willReadFrequently: false })!;

const TOOLS: Array<{ id: Tool; label: string; key: string; icon: typeof Brush; tip: string }> = [
  { id: "brush", label: "Cọ", key: "B", icon: Brush, tip: "Tô theo điểm / nét (bấm 1 lần = 1 chấm)" },
  { id: "lasso", label: "Vùng", key: "L", icon: Lasso, tip: "Kéo vòng quanh 1 vùng — cả vùng được thêm / bớt" },
  { id: "wand", label: "Đũa thần", key: "W", icon: Wand2, tip: "Bấm vào 1 màu — chọn cả mảng cùng màu (như Photoshop)" },
  { id: "island", label: "Mảng", key: "I", icon: Sparkles, tip: "Bớt: bấm vào 1 mảnh rời → xoá cả mảnh. Thêm: bấm vào 1 lỗ thủng → lấp cả lỗ" },
  { id: "smooth", label: "Làm mịn", key: "S", icon: Droplets, tip: "Tô lên mép cắt — mép bớt sắc, bớt răng cưa (chỉ làm mờ vào trong, không thêm màu)" },
  { id: "move", label: "Di chuyển", key: "V", icon: Move, tip: "Kéo cả bộ clipart (trước + sau) tới chỗ mới — phím mũi tên = 1 px, Shift = 10 px" },
  { id: "hand", label: "Tay", key: "H", icon: Hand, tip: "Kéo khung nhìn (hoặc giữ Space)" },
];

/** Box blur of a W×H float plane, radius r (in place, three passes ≈ a Gaussian of σ ≈ r). */
function blurPlane(a: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(a.length);
  const pass = (src: Float32Array, dst: Float32Array, n: number, m: number, stride: number, step: number) => {
    // n lines of m samples; sample j of line i at i * stride + j * step.
    const k = 2 * r + 1;
    for (let i = 0; i < n; i++) {
      const o = i * stride;
      let acc = 0;
      for (let j = -r; j <= r; j++) acc += src[o + Math.min(m - 1, Math.max(0, j)) * step];
      for (let j = 0; j < m; j++) {
        dst[o + j * step] = acc / k;
        acc += src[o + Math.min(m - 1, j + r + 1) * step] - src[o + Math.max(0, j - r) * step];
      }
    }
  };
  for (let t = 0; t < 3; t++) {
    pass(a, tmp, h, w, w, 1);
    pass(tmp, a, w, h, 1, w);
  }
  return a;
}

/** The mask's edge softened inwards: blurred, its ramp moved inside the edge, never more than it was. */
function smoothedAlpha(alpha: Float32Array, w: number, h: number, r: number): Float32Array {
  const b = blurPlane(Float32Array.from(alpha), w, h, r);
  for (let i = 0; i < b.length; i++) b[i] = Math.min(alpha[i], Math.min(1, Math.max(0, 2 * b[i] - 0.8)));
  return b;
}

/** Ctrl / ⌘ as the platform writes it. */
const MOD = typeof navigator !== "undefined" && /Mac|iP(hone|ad)/.test(navigator.platform) ? "⌘" : "Ctrl+";

export function MaskEditor(props: MaskEditorProps) {
  const { width: W, height: H } = props;
  const tint = props.tint ?? "#f97316";
  const wrap = useRef<HTMLDivElement | null>(null);
  const view = useRef<HTMLCanvasElement | null>(null);
  const mini = useRef<HTMLCanvasElement | null>(null);
  const ring = useRef<HTMLDivElement | null>(null);
  const store = useRef<{
    colour: HTMLImageElement;
    subject: HTMLImageElement | null;
    others: Array<{ img: HTMLImageElement; color: string }>;
    context: Array<{ img: HTMLImageElement; moves: boolean }>;
    mask: HTMLCanvasElement;
    committed: HTMLCanvasElement;
    tmp: HTMLCanvasElement;
    pixels: Uint8ClampedArray | null;
    /** The smoothing brush's stroke: the mask's alpha when it began, the same smoothed, and the brush's cover. */
    smooth: { alpha: Float32Array; soft: Float32Array; cover: Float32Array } | null;
  } | null>(null);
  const undo = useRef<Patch[]>([]);
  const redo = useRef<Patch[]>([]);
  const stroke = useRef<{ last: { x: number; y: number } | null; box: Box | null; lasso: Array<[number, number]> } | null>(null);
  const pan = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const drag = useRef<{ sx: number; sy: number; dx: number; dy: number } | null>(null);
  const frame = useRef(0);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("brush");
  // Bớt first: an editor is opened mostly to take off what the AI left over (asked 2026-10-12).
  const [op, setOp] = useState<Op>("remove");
  const [alt, setAlt] = useState(false);
  const [space, setSpace] = useState(false);
  const [size, setSize] = useState(40);
  const [hard, setHard] = useState(0.8);
  const [tol, setTol] = useState(18);
  const [soften, setSoften] = useState(2);
  const [contiguous, setContiguous] = useState(true);
  const [viewMode, setViewMode] = useState<View>(props.focusPiece ? "result" : "overlay");
  const [showOthers, setShowOthers] = useState(true);
  const [z, setZ] = useState({ s: 0.2, ox: 0, oy: 0 });
  const [changes, setChanges] = useState(0);
  const [canRedo, setCanRedo] = useState(false);
  const [busy, setBusy] = useState<"save" | "revert" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // Where the clipart was dragged to (whole px on the canvas).
  const [off, setOff] = useState({ dx: 0, dy: 0 });
  // The preview's own zoom: scale, and its shift in css px of the preview box.
  // The preview's own zoom: scale (500 % to start) and the canvas point at its centre — it follows the pointer over
  // the editing area (asked 2026-10-14); at 100 % the whole canvas fits.
  const [pz, setPz] = useState({ s: 5, fx: W / 2, fy: H / 2 });
  const pzPan = useRef<{ sx: number; sy: number; fx: number; fy: number } | null>(null);
  /** css px of the preview per canvas px at 100 %. */
  const perPx = () => (mini.current?.clientWidth || 240) / W;
  const moved = off.dx !== 0 || off.dy !== 0;
  const dirty = changes > 0 || moved;
  const effOp: Op = alt ? (op === "add" ? "remove" : "add") : op;
  const effTool: Tool = space ? "hand" : tool;

  // ---- load ----
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [colour, maskImg, subject, others, context] = await Promise.all([
          loadImg(props.colourUrl),
          loadImg(props.maskUrl),
          props.subjectUrl ? loadImg(props.subjectUrl) : Promise.resolve(null),
          Promise.all((props.others ?? []).map(async (o) => ({ img: await loadImg(o.url), color: o.color }))),
          Promise.all((props.context ?? []).map(async (o) => ({ img: await loadImg(o.url), moves: o.moves }))),
        ]);
        if (!live) return;
        const mask = canvas(W, H);
        ctx2d(mask).drawImage(maskImg, 0, 0, W, H);
        const committed = canvas(W, H);
        ctx2d(committed).drawImage(mask, 0, 0);
        store.current = { colour, subject, others, context, mask, committed, tmp: canvas(W, H), pixels: null, smooth: null };
        setReady(true);
      } catch (e) {
        if (live) setLoadError(e instanceof Error ? e.message : "Không tải được ảnh");
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loaded once per open
  }, []);

  // Fit the picture in the window once it is there.
  const fitView = useCallback(() => {
    const el = wrap.current;
    if (!el) return;
    const s = Math.min(el.clientWidth / W, el.clientHeight / H) * 0.96;
    setZ({ s, ox: (el.clientWidth - W * s) / 2, oy: (el.clientHeight - H * s) / 2 });
  }, [W, H]);
  /** The region's box (× the subject), zoomed to fill the window. */
  const fitPiece = useCallback(() => {
    const el = wrap.current;
    const st = store.current;
    if (!el || !st) return false;
    const k = Math.max(1, Math.round(Math.max(W, H) / 512));
    const w = Math.ceil(W / k);
    const h = Math.ceil(H / k);
    const c = canvas(w, h);
    const g = ctx2d(c);
    g.drawImage(st.mask, 0, 0, w, h);
    if (st.subject) {
      g.globalCompositeOperation = "destination-in";
      g.drawImage(st.subject, 0, 0, w, h);
    }
    const px = g.getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (px[(y * w + x) * 4 + 3] > 64) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
    if (x1 < 0) return false;
    const pad = Math.max(x1 - x0, y1 - y0) * 0.12 + 4;
    const bx = (x0 - pad) * k, by = (y0 - pad) * k, bw = (x1 - x0 + 2 * pad) * k, bh = (y1 - y0 + 2 * pad) * k;
    const sc = Math.min(el.clientWidth / bw, el.clientHeight / bh);
    setZ({ s: sc, ox: el.clientWidth / 2 - (bx + bw / 2) * sc, oy: el.clientHeight / 2 - (by + bh / 2) * sc });
    setPz((cur) => ({ ...cur, fx: bx + bw / 2, fy: by + bh / 2 }));
    return true;
  }, [W, H]);
  useEffect(() => {
    if (!ready) return;
    if (!(props.focusPiece && fitPiece())) fitView();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the pictures are in
  }, [ready]);

  // ---- the live preview: the outfit as the product shows it (3c), the clipart in its place with what is unsaved ----
  const renderMini = useCallback(() => {
    const st = store.current;
    if (!st) return;
    const t = ctx2d(st.tmp);
    const m = mini.current;
    if (m && st.context.length) {
      const pg = ctx2d(m);
      const k = m.width / W;
      t.globalCompositeOperation = "source-over";
      t.clearRect(0, 0, W, H);
      t.drawImage(st.colour, 0, 0, W, H);
      t.globalCompositeOperation = "destination-in";
      t.drawImage(st.mask, 0, 0);
      if (st.subject) t.drawImage(st.subject, 0, 0, W, H);
      t.globalCompositeOperation = "source-over";
      pg.setTransform(1, 0, 0, 1, 0, 0);
      pg.clearRect(0, 0, m.width, m.height);
      // Its own zoom, drawn at the size it is shown (sharp at any zoom): the centre point at the preview's centre.
      const ox = pz.s <= 1 ? 0 : m.width / 2 - pz.fx * k * pz.s;
      const oy = pz.s <= 1 ? 0 : m.height / 2 - pz.fy * k * pz.s;
      pg.setTransform(k * pz.s, 0, 0, k * pz.s, ox, oy);
      pg.imageSmoothingQuality = "high";
      const at = Math.min(props.selfAt ?? st.context.length, st.context.length);
      st.context.forEach((o, i) => {
        if (i === at) pg.drawImage(st.tmp, off.dx, off.dy, W, H);
        pg.drawImage(o.img, o.moves ? off.dx : 0, o.moves ? off.dy : 0, W, H);
      });
      if (at >= st.context.length) pg.drawImage(st.tmp, off.dx, off.dy, W, H);
      pg.setTransform(1, 0, 0, 1, 0, 0);
    }
  }, [W, H, off, props.selfAt, pz]);

  // ---- render ----
  const render = useCallback(() => {
    const st = store.current;
    const c = view.current;
    if (!st || !c) return;
    const g = ctx2d(c);
    const t = ctx2d(st.tmp);
    g.globalCompositeOperation = "source-over";
    g.globalAlpha = 1;
    g.clearRect(0, 0, W, H);
    const tinted = (src: CanvasImageSource, color: string, alpha: number) => {
      t.globalCompositeOperation = "source-over";
      t.clearRect(0, 0, W, H);
      t.drawImage(src, 0, 0, W, H);
      t.globalCompositeOperation = "source-in";
      t.fillStyle = color;
      t.fillRect(0, 0, W, H);
      t.globalCompositeOperation = "source-over";
      g.globalAlpha = alpha;
      g.drawImage(st.tmp, 0, 0);
      g.globalAlpha = 1;
    };
    if (viewMode === "result") {
      // The outfit dimmed and dark, the clipart being edited bright over it (the faded original picture behind it is
      // gone — asked 2026-10-23: "ảnh mờ phía sau … bỏ đi").
      if (st.context.length) {
        for (const o of st.context) g.drawImage(o.img, o.moves ? off.dx : 0, o.moves ? off.dy : 0, W, H);
        g.globalCompositeOperation = "source-atop";
        g.fillStyle = "rgba(0,0,0,0.78)";
        g.fillRect(0, 0, W, H);
        g.globalCompositeOperation = "source-over";
      }
      t.globalCompositeOperation = "source-over";
      t.clearRect(0, 0, W, H);
      t.drawImage(st.colour, 0, 0, W, H);
      t.globalCompositeOperation = "destination-in";
      t.drawImage(st.mask, 0, 0);
      if (st.subject) t.drawImage(st.subject, 0, 0, W, H);
      t.globalCompositeOperation = "source-over";
      g.drawImage(st.tmp, off.dx, off.dy, W, H);
      g.save();
      g.translate(off.dx, off.dy);
    } else {
      g.save();
      g.translate(off.dx, off.dy);
      g.drawImage(st.colour, 0, 0, W, H);
      if (showOthers) for (const o of st.others) tinted(o.img, o.color, 0.28);
      tinted(st.mask, tint, 0.55);
    }
    const s = stroke.current;
    if (s && s.lasso.length > 1) {
      g.save();
      g.lineWidth = Math.max(2, 2 / z.s);
      g.setLineDash([8 / z.s, 6 / z.s]);
      g.strokeStyle = effOp === "add" ? "#22c55e" : "#ef4444";
      g.beginPath();
      s.lasso.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      g.stroke();
      g.restore();
    }
    g.restore();
    renderMini();
  }, [W, H, viewMode, showOthers, tint, z.s, effOp, off, renderMini]);

  const schedule = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      render();
    });
  }, [render]);

  useEffect(() => {
    if (ready) render();
  }, [ready, render]);
  useEffect(() => {
    if (ready) renderMini();
  }, [ready, renderMini]);

  // ---- edits ----
  const grow = (b: Box | null, x0: number, y0: number, x1: number, y1: number): Box => (b ? { x0: Math.min(b.x0, x0), y0: Math.min(b.y0, y0), x1: Math.max(b.x1, x1), y1: Math.max(b.y1, y1) } : { x0, y0, x1, y1 });

  /** Done with one change: keep the changed rectangle before / after for undo. */
  const commit = (b: Box | null) => {
    const st = store.current;
    if (!st || !b) return;
    const x = Math.max(0, Math.floor(b.x0));
    const y = Math.max(0, Math.floor(b.y0));
    const w = Math.min(W, Math.ceil(b.x1)) - x;
    const h = Math.min(H, Math.ceil(b.y1)) - y;
    if (w <= 0 || h <= 0) return;
    const before = ctx2d(st.committed).getImageData(x, y, w, h);
    const after = ctx2d(st.mask).getImageData(x, y, w, h);
    ctx2d(st.committed).putImageData(after, x, y);
    undo.current.push({ x, y, before, after });
    if (undo.current.length > 60) undo.current.shift();
    redo.current = [];
    setCanRedo(false);
    setChanges((n) => n + 1);
  };

  const step = (back: boolean) => {
    const st = store.current;
    const from = back ? undo.current : redo.current;
    const p = from.pop();
    if (!st || !p) return;
    const data = back ? p.before : p.after;
    ctx2d(st.mask).putImageData(data, p.x, p.y);
    ctx2d(st.committed).putImageData(data, p.x, p.y);
    (back ? redo.current : undo.current).push(p);
    setCanRedo(redo.current.length > 0);
    setChanges((n) => n + (back ? -1 : 1));
    schedule();
  };

  const stamp = (x: number, y: number) => {
    const st = store.current!;
    const g = ctx2d(st.mask);
    const r = size / 2;
    g.globalCompositeOperation = effOp === "add" ? "source-over" : "destination-out";
    if (hard >= 0.98) {
      g.fillStyle = "#fff";
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    } else {
      const grad = g.createRadialGradient(x, y, r * hard, x, y, r);
      grad.addColorStop(0, "rgba(255,255,255,1)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grad;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    g.globalCompositeOperation = "source-over";
    stroke.current!.box = grow(stroke.current!.box, x - r - 1, y - r - 1, x + r + 1, y + r + 1);
  };

  const line = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const gap = Math.max(1, size * 0.2);
    const n = Math.ceil(d / gap);
    for (let i = 1; i <= n; i++) (effTool === "smooth" ? smoothStamp : stamp)(a.x + ((b.x - a.x) * i) / n, a.y + ((b.y - a.y) * i) / n);
  };

  /** The mask's alpha as a float plane. */
  const alphaOf = (): Float32Array => {
    const d = ctx2d(store.current!.mask).getImageData(0, 0, W, H).data;
    const a = new Float32Array(W * H);
    for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3] / 255;
    return a;
  };

  /** Write alpha (inside the box; `at` = alpha of canvas pixel i) back to the mask, white. */
  const putAlpha = (b: Box, at: (i: number) => number) => {
    const x0 = Math.max(0, Math.floor(b.x0));
    const y0 = Math.max(0, Math.floor(b.y0));
    const w = Math.min(W, Math.ceil(b.x1)) - x0;
    const h = Math.min(H, Math.ceil(b.y1)) - y0;
    if (w <= 0 || h <= 0) return;
    const img = new ImageData(w, h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(at((y0 + y) * W + x0 + x) * 255);
      }
    ctx2d(store.current!.mask).putImageData(img, x0, y0);
  };

  /** The smoothing brush at (x, y): the stroke's cover grows, the mask there = its start blended to the smoothed. */
  const smoothStamp = (x: number, y: number) => {
    const sm = store.current!.smooth;
    if (!sm) return;
    const r = size / 2;
    const bx0 = Math.max(0, Math.floor(x - r)), by0 = Math.max(0, Math.floor(y - r));
    const bx1 = Math.min(W - 1, Math.ceil(x + r)), by1 = Math.min(H - 1, Math.ceil(y + r));
    if (bx1 < bx0 || by1 < by0) return;
    for (let py = by0; py <= by1; py++)
      for (let px = bx0; px <= bx1; px++) {
        const d = Math.hypot(px + 0.5 - x, py + 0.5 - y) / r;
        if (d >= 1) continue;
        const wgt = d <= hard ? 1 : (1 - d) / Math.max(0.001, 1 - hard);
        const i = py * W + px;
        if (wgt > sm.cover[i]) sm.cover[i] = wgt;
      }
    putAlpha({ x0: bx0, y0: by0, x1: bx1 + 1, y1: by1 + 1 }, (i) => sm.alpha[i] + (sm.soft[i] - sm.alpha[i]) * sm.cover[i]);
    stroke.current!.box = grow(stroke.current!.box, bx0, by0, bx1 + 1, by1 + 1);
  };

  /** "Làm mịn cả viền": the whole mask's edge at once. */
  const smoothAll = () => {
    if (!store.current || props.readOnly) return;
    const soft = smoothedAlpha(alphaOf(), W, H, soften);
    putAlpha({ x0: 0, y0: 0, x1: W, y1: H }, (i) => soft[i]);
    commit({ x0: 0, y0: 0, x1: W, y1: H });
    schedule();
  };

  const fillLasso = (pts: Array<[number, number]>) => {
    const st = store.current!;
    if (pts.length < 3) return null;
    const g = ctx2d(st.mask);
    g.globalCompositeOperation = effOp === "add" ? "source-over" : "destination-out";
    g.fillStyle = "#fff";
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    g.fill();
    g.globalCompositeOperation = "source-over";
    let b: Box | null = null;
    for (const [x, y] of pts) b = grow(b, x - 2, y - 2, x + 2, y + 2);
    return b;
  };

  /** Apply a 0/1 selection (inside box) to the mask. */
  const applySelection = (sel: Uint8Array, b: Box) => {
    const st = store.current!;
    const w = b.x1 - b.x0 + 1;
    const h = b.y1 - b.y0 + 1;
    const img = new ImageData(w, h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (!sel[(b.y0 + y) * W + (b.x0 + x)]) continue;
        const i = (y * w + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = img.data[i + 3] = 255;
      }
    const c = canvas(w, h);
    ctx2d(c).putImageData(img, 0, 0);
    const g = ctx2d(st.mask);
    g.globalCompositeOperation = effOp === "add" ? "source-over" : "destination-out";
    g.drawImage(c, b.x0, b.y0);
    g.globalCompositeOperation = "source-over";
    commit({ x0: b.x0, y0: b.y0, x1: b.x1 + 1, y1: b.y1 + 1 });
  };

  /** Flood fill from (sx, sy) over pixels where `inside(i)`; contiguous or everywhere. */
  const flood = (sx: number, sy: number, inside: (i: number) => boolean, all: boolean): { sel: Uint8Array; box: Box | null; edge: boolean; n: number } => {
    const sel = new Uint8Array(W * H);
    let box: Box | null = null;
    let edge = false;
    let n = 0;
    const mark = (x: number, y: number) => {
      sel[y * W + x] = 1;
      n++;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) edge = true;
      box = box ? { x0: Math.min(box.x0, x), y0: Math.min(box.y0, y), x1: Math.max(box.x1, x), y1: Math.max(box.y1, y) } : { x0: x, y0: y, x1: x, y1: y };
    };
    if (all) {
      for (let i = 0; i < W * H; i++) if (inside(i)) mark(i % W, Math.floor(i / W));
      return { sel, box, edge, n };
    }
    if (!inside(sy * W + sx)) return { sel, box, edge, n };
    const stack: number[] = [sx, sy];
    while (stack.length) {
      const y = stack.pop()!;
      let x = stack.pop()!;
      while (x > 0 && !sel[y * W + x - 1] && inside(y * W + x - 1)) x--;
      let up = false;
      let down = false;
      for (; x < W && !sel[y * W + x] && inside(y * W + x); x++) {
        mark(x, y);
        if (y > 0) {
          const ok = !sel[(y - 1) * W + x] && inside((y - 1) * W + x);
          if (ok && !up) stack.push(x, y - 1);
          up = ok;
        }
        if (y < H - 1) {
          const ok = !sel[(y + 1) * W + x] && inside((y + 1) * W + x);
          if (ok && !down) stack.push(x, y + 1);
          down = ok;
        }
      }
    }
    return { sel, box, edge, n };
  };

  const wand = (x: number, y: number) => {
    const st = store.current!;
    if (!st.pixels) {
      const c = canvas(W, H);
      const g = ctx2d(c);
      g.drawImage(st.colour, 0, 0, W, H);
      st.pixels = g.getImageData(0, 0, W, H).data;
    }
    const px = st.pixels;
    const s = (y * W + x) * 4;
    const r = px[s];
    const gr = px[s + 1];
    const b = px[s + 2];
    const t = tol * 2.55;
    const { sel, box } = flood(x, y, (i) => Math.max(Math.abs(px[i * 4] - r), Math.abs(px[i * 4 + 1] - gr), Math.abs(px[i * 4 + 2] - b)) <= t, !contiguous);
    if (box) applySelection(sel, box);
  };

  const island = (x: number, y: number) => {
    const st = store.current!;
    const a = ctx2d(st.mask).getImageData(0, 0, W, H).data;
    if (effOp === "remove") {
      if (a[(y * W + x) * 4 + 3] <= 8) return setMsg("Bấm vào đúng mảnh cần xoá");
      const { sel, box } = flood(x, y, (i) => a[i * 4 + 3] > 8, false);
      if (box) applySelection(sel, box);
    } else {
      if (a[(y * W + x) * 4 + 3] >= 128) return setMsg("Bấm vào bên trong 1 lỗ thủng để lấp");
      const { sel, box, edge } = flood(x, y, (i) => a[i * 4 + 3] < 128, false);
      if (edge) return setMsg("Chỗ này nối ra mép ảnh, không phải lỗ thủng — dùng Cọ hoặc Vùng");
      if (box) applySelection(sel, box);
    }
  };

  // ---- pointer ----
  /** A pointer on the clipart's own canvas (where it was before it was dragged: the mask stays there). */
  const at = (e: { clientX: number; clientY: number }) => {
    const r = view.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W - off.dx, y: ((e.clientY - r.top) / r.height) * H - off.dy };
  };

  const moveRing = (e: { clientX: number; clientY: number }) => {
    const el = ring.current;
    const box = wrap.current?.getBoundingClientRect();
    if (!el || !box) return;
    const d = size * z.s;
    el.style.width = el.style.height = `${d}px`;
    el.style.transform = `translate(${e.clientX - box.left - d / 2}px, ${e.clientY - box.top - d / 2}px)`;
  };

  const down = (e: React.PointerEvent) => {
    if (!ready || (props.readOnly && effTool !== "hand")) return;
    setMsg(null);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    if (effTool === "hand" || e.button === 1) {
      pan.current = { sx: e.clientX, sy: e.clientY, ox: z.ox, oy: z.oy };
      return;
    }
    if (e.button !== 0) return;
    if (effTool === "move") {
      drag.current = { sx: e.clientX, sy: e.clientY, dx: off.dx, dy: off.dy };
      return;
    }
    const p = at(e);
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= W || y >= H) {
      if (effTool !== "lasso" && effTool !== "brush") return;
    }
    if (effTool === "wand") return wand(Math.min(W - 1, Math.max(0, x)), Math.min(H - 1, Math.max(0, y))), schedule();
    if (effTool === "island") return island(Math.min(W - 1, Math.max(0, x)), Math.min(H - 1, Math.max(0, y))), schedule();
    stroke.current = { last: p, box: null, lasso: effTool === "lasso" ? [[p.x, p.y]] : [] };
    if (effTool === "brush") stamp(p.x, p.y);
    if (effTool === "smooth") {
      const a = alphaOf();
      store.current!.smooth = { alpha: a, soft: smoothedAlpha(a, W, H, soften), cover: new Float32Array(W * H) };
      smoothStamp(p.x, p.y);
    }
    schedule();
  };

  const move = (e: React.PointerEvent) => {
    moveRing(e);
    // The preview follows the pointer: the canvas point under it (where the outfit is) at the preview's centre.
    if (view.current) {
      const r = view.current.getBoundingClientRect();
      setPz((cur) => ({ ...cur, fx: ((e.clientX - r.left) / r.width) * W, fy: ((e.clientY - r.top) / r.height) * H }));
    }
    if (pan.current) {
      const pn = pan.current;
      setZ((cur) => ({ ...cur, ox: pn.ox + e.clientX - pn.sx, oy: pn.oy + e.clientY - pn.sy }));
      return;
    }
    if (drag.current) {
      const d = drag.current;
      setOff({ dx: Math.round(d.dx + (e.clientX - d.sx) / z.s), dy: Math.round(d.dy + (e.clientY - d.sy) / z.s) });
      return;
    }
    const s = stroke.current;
    if (!s) return;
    const p = at(e);
    if ((effTool === "brush" || effTool === "smooth") && s.last) {
      line(s.last, p);
      s.last = p;
    } else if (effTool === "lasso") s.lasso.push([p.x, p.y]);
    schedule();
  };

  const up = () => {
    if (pan.current || drag.current) {
      pan.current = null;
      drag.current = null;
      return;
    }
    const s = stroke.current;
    if (!s) return;
    const box = effTool === "lasso" ? fillLasso(s.lasso) : s.box;
    stroke.current = null;
    if (store.current) store.current.smooth = null;
    commit(box);
    schedule();
  };

  // Wheel / trackpad pinch zooms the picture, never the page: the browser's own zoom (Ctrl / ⌘ + wheel, a pinch,
  // Safari's gesture events) is held off anywhere while the editor is open (asked 2026-10-12).
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const box = el.getBoundingClientRect();
      const mx = e.clientX - box.left;
      const my = e.clientY - box.top;
      const dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
      const k = Math.min(1.5, Math.max(1 / 1.5, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015))));
      setZ((cur) => {
        const s = Math.min(16, Math.max(0.05, cur.s * k));
        return { s, ox: mx - ((mx - cur.ox) * s) / cur.s, oy: my - ((my - cur.oy) * s) / cur.s };
      });
    };
    const noZoom = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    };
    const noGesture = (e: Event) => e.preventDefault();
    el.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("wheel", noZoom, { passive: false });
    document.addEventListener("gesturestart", noGesture);
    document.addEventListener("gesturechange", noGesture);
    return () => {
      el.removeEventListener("wheel", onWheel);
      window.removeEventListener("wheel", noZoom);
      document.removeEventListener("gesturestart", noGesture);
      document.removeEventListener("gesturechange", noGesture);
    };
  }, []);

  // The preview zooms round the pointer (wheel / pinch); dragged = panned; double click = fit.
  useEffect(() => {
    const el = mini.current;
    if (!el || !ready) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const box = el.getBoundingClientRect();
      const mx = e.clientX - box.left;
      const my = e.clientY - box.top;
      const dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
      const k = Math.min(1.5, Math.max(1 / 1.5, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015))));
      setPz((cur) => {
        const s = Math.min(12, Math.max(1, cur.s * k));
        // The canvas point under the pointer stays under it.
        const u = perPx();
        const cx0 = cur.s <= 1 ? W / 2 : cur.fx;
        const cy0 = cur.s <= 1 ? H / 2 : cur.fy;
        const px = cx0 + (mx - box.width / 2) / (u * Math.max(cur.s, 1));
        const py = cy0 + (my - box.height / 2) / (u * Math.max(cur.s, 1));
        return { s, fx: px - ((px - cx0) * cur.s) / s, fy: py - ((py - cy0) * cur.s) / s };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ready]);

  /** The preview's +/−: round its centre. */
  const zoomPreview = (k: number) => setPz((cur) => ({ ...cur, s: Math.min(12, Math.max(1, cur.s * k)) }));

  const zoomBy = (k: number) => {
    const el = wrap.current;
    if (!el) return;
    const mx = el.clientWidth / 2;
    const my = el.clientHeight / 2;
    setZ((cur) => {
      const s = Math.min(16, Math.max(0.05, cur.s * k));
      return { s, ox: mx - ((mx - cur.ox) * s) / cur.s, oy: my - ((my - cur.oy) * s) / cur.s };
    });
  };

  // ---- keys ----
  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "Alt") setAlt(true);
      if (e.key === " ") {
        setSpace(true);
        e.preventDefault();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        step(!e.shiftKey);
        return;
      }
      // ⌘ + / − / 0 zoom the picture, not the page.
      if ((e.metaKey || e.ctrlKey) && ["=", "+", "-", "_", "0"].includes(e.key)) {
        e.preventDefault();
        if (e.key === "0") fitView();
        else zoomBy(e.key === "-" || e.key === "_" ? 1 / 1.3 : 1.3);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!props.readOnly && dirty && !busy) void save();
        return;
      }
      if (e.metaKey || e.ctrlKey) return;
      if (props.movable && tool === "move" && e.key.startsWith("Arrow")) {
        e.preventDefault();
        const k = e.shiftKey ? 10 : 1;
        setOff((o) => ({ dx: o.dx + (e.key === "ArrowLeft" ? -k : e.key === "ArrowRight" ? k : 0), dy: o.dy + (e.key === "ArrowUp" ? -k : e.key === "ArrowDown" ? k : 0) }));
        return;
      }
      const t = tools.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
      if (t) setTool(t.id);
      if (e.key.toLowerCase() === "m" && !props.readOnly) smoothAll();
      if (e.key.toLowerCase() === "x") setOp((o) => (o === "add" ? "remove" : "add"));
      if (e.key === "[") setSize((v) => Math.max(2, Math.round(v / 1.25)));
      if (e.key === "]") setSize((v) => Math.min(600, Math.round(v * 1.25)));
      if (e.key === "Escape") props.onClose();
    };
    const ku = (e: KeyboardEvent) => {
      if (e.key === "Alt") setAlt(false);
      if (e.key === " ") setSpace(false);
    };
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    return () => {
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
    };
  });

  const save = async (close = true): Promise<boolean> => {
    const st = store.current;
    if (!st) return false;
    setBusy("save");
    setMsg(null);
    try {
      const blob = await new Promise<Blob | null>((res) => st.mask.toBlob(res, "image/png"));
      if (!blob) throw new Error("Không xuất được mặt nạ");
      const url = await new Promise<string>((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.onerror = () => rej(new Error("Không đọc được mặt nạ"));
        fr.readAsDataURL(blob);
      });
      await props.onSave(changes > 0 ? url : null, moved ? off : null);
      if (close) props.onClose();
      return true;
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Không lưu được");
      return false;
    } finally {
      setBusy(null);
    }
  };

  const revert = async () => {
    if (!window.confirm("Quay về bản đã lưu trước đó?")) return;
    setBusy("revert");
    try {
      await props.onRevert();
      props.onClose();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Không hoàn tác được");
    } finally {
      setBusy(null);
    }
  };

  /** Open another clipart: what is unsaved here is saved first (asked), else it stays open. */
  const leave = (go: () => void) => {
    if (busy) return;
    if (!dirty) return go();
    if (!window.confirm("Clipart này có thay đổi chưa lưu. Lưu rồi mở clipart kia?")) return;
    void save(false).then((ok) => ok && go());
  };

  const close = () => {
    if (dirty && !window.confirm("Bỏ các thay đổi chưa lưu?")) return;
    props.onClose();
  };

  const cursor = effTool === "hand" ? (pan.current ? "grabbing" : "grab") : effTool === "move" ? "move" : effTool === "brush" || effTool === "smooth" ? "none" : "crosshair";
  const tools = TOOLS.filter((t) => t.id !== "move" || props.movable);

  const side = (on: boolean, extra?: string) =>
    cx("flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs", on ? extra ?? "bg-foreground text-background" : "hover:bg-accent");
  const keyTag = (k: string) => <span className="ml-auto pl-1 text-[10px] opacity-60">({k})</span>;
  const brushy = effTool === "brush" || effTool === "smooth";

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <div className="mr-2 min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{props.title}</div>
          {props.hint && <div className="truncate text-[11px] text-muted-foreground" title={props.hint}>{props.hint}</div>}
        </div>
        <div className="flex items-center gap-1 rounded-md border p-0.5 text-xs">
          <button onClick={() => setViewMode("result")} className={cx("rounded px-2 py-1", viewMode === "result" ? "bg-foreground text-background" : "hover:bg-accent")} title="Xem kết quả cắt trên nền ô cờ">
            Kết quả
          </button>
          <button onClick={() => setViewMode("overlay")} className={cx("rounded px-2 py-1", viewMode === "overlay" ? "bg-foreground text-background" : "hover:bg-accent")} title="Ảnh gốc, vùng của lớp tô màu">
            Tô màu vùng
          </button>
        </div>
        {viewMode !== "result" &&
          (props.others?.length ?? 0) > 0 && (
            <label className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={showOthers} onChange={(e) => setShowOthers(e.target.checked)} />
              Các lớp khác
            </label>
          )}
        <div className="flex items-center gap-0.5 text-xs">
          <button className="rounded p-1 hover:bg-accent" onClick={() => zoomBy(1 / 1.3)} title={`Thu nhỏ (${MOD}−)`}>
            <Minus className="h-3.5 w-3.5" />
          </button>
          <button className="w-12 rounded px-1 py-0.5 tabular-nums hover:bg-accent" onClick={fitView} title={`Vừa khung (${MOD}0)`}>
            {Math.round(z.s * 100)}%
          </button>
          <button className="rounded p-1 hover:bg-accent" onClick={() => zoomBy(1.3)} title={`Phóng to (${MOD}+)`}>
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="flex items-center gap-2">
          {msg && <span className="max-w-xs truncate text-xs text-destructive" title={msg}>{msg}</span>}
          {!props.readOnly && props.canRevert && (
            <CtButton disabled={!!busy} onClick={() => void revert()} title="Quay về bản đã lưu trước đó">
              {busy === "revert" ? <Loader2 className="h-4 w-4 animate-spin" /> : <History className="h-4 w-4" />}
              Bản lưu trước
            </CtButton>
          )}
          {!props.readOnly && (
            <CtButton variant="primary" disabled={!!busy || !dirty} onClick={() => void save()}>
              {busy === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Lưu ({MOD}S)
            </CtButton>
          )}
          <button className="flex items-center gap-1 rounded p-1.5 text-xs hover:bg-accent" onClick={close} title="Đóng (Esc)">
            <X className="h-4 w-4" /> <span className="text-[10px] opacity-60">(Esc)</span>
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        {!props.readOnly && (
          <div className="flex w-48 shrink-0 flex-col gap-3 overflow-y-auto border-r p-2">
            <div className="flex flex-col gap-0.5">
              {tools.map((t) => (
                <button key={t.id} title={t.tip} onClick={() => setTool(t.id)} className={side(effTool === t.id)}>
                  <t.icon className="h-4 w-4 shrink-0" />
                  {t.label}
                  {keyTag(t.id === "hand" ? "H / Space" : t.key)}
                </button>
              ))}
            </div>
            {effTool === "move" && (
              <div className="flex flex-col gap-1 border-t pt-2 text-xs">
                <div className="px-2 tabular-nums">
                  Lệch: {off.dx} px, {off.dy} px
                </div>
                <button onClick={() => setOff({ dx: 0, dy: 0 })} disabled={!moved} className={cx(side(false), "disabled:opacity-30")}>
                  <RotateCcw className="h-4 w-4 shrink-0" />
                  Về chỗ cũ
                </button>
                <div className="px-2 text-[10px] text-muted-foreground">Kéo trên ảnh · mũi tên = 1 px, Shift = 10 px. Lưu = mọi màu của kiểu này, lớp trước + sau, mọi sản phẩm.</div>
              </div>
            )}
            {effTool !== "hand" && effTool !== "smooth" && effTool !== "move" && (
              <div className="flex flex-col gap-0.5 border-t pt-2" title="X để đổi, giữ Alt để dùng tạm cái kia">
                <button onClick={() => setOp("remove")} className={side(effOp === "remove", "bg-red-600 text-white")}>
                  <Minus className="h-4 w-4 shrink-0" />
                  Bớt khỏi lớp
                  {keyTag("X")}
                </button>
                <button onClick={() => setOp("add")} className={side(effOp === "add", "bg-emerald-600 text-white")}>
                  <Plus className="h-4 w-4 shrink-0" />
                  Thêm vào lớp
                  {keyTag("X")}
                </button>
                <div className="px-2 text-[10px] text-muted-foreground">Giữ Alt = tạm đổi</div>
              </div>
            )}
            {brushy && (
              <div className="flex flex-col gap-1.5 border-t pt-2 text-xs">
                <label className="flex flex-col gap-0.5">
                  <span className="flex">
                    Cỡ cọ <span className="ml-auto tabular-nums">{size}</span>
                  </span>
                  <input type="range" min={2} max={400} value={size} onChange={(e) => setSize(Number(e.target.value))} />
                  <span className="text-[10px] text-muted-foreground">([ nhỏ · ] to)</span>
                </label>
                <label className="flex flex-col gap-0.5" title="Viền cọ: mềm ↔ cứng">
                  <span className="flex">
                    Độ cứng <span className="ml-auto tabular-nums">{Math.round(hard * 100)}</span>
                  </span>
                  <input type="range" min={0} max={100} value={Math.round(hard * 100)} onChange={(e) => setHard(Number(e.target.value) / 100)} />
                </label>
              </div>
            )}
            {effTool === "wand" && (
              <div className="flex flex-col gap-1.5 border-t pt-2 text-xs">
                <label className="flex flex-col gap-0.5" title="Độ lệch màu được chọn chung">
                  <span className="flex">
                    Dung sai <span className="ml-auto tabular-nums">{tol}</span>
                  </span>
                  <input type="range" min={1} max={80} value={tol} onChange={(e) => setTol(Number(e.target.value))} />
                </label>
                <label className="flex items-center gap-1" title="Bỏ chọn = mọi chỗ cùng màu trong ảnh">
                  <input type="checkbox" checked={contiguous} onChange={(e) => setContiguous(e.target.checked)} />
                  Liền mạch
                </label>
              </div>
            )}
            <div className="flex flex-col gap-1.5 border-t pt-2 text-xs">
              <label className="flex flex-col gap-0.5" title="Mép mềm bao nhiêu px (cho Làm mịn và Làm mịn cả viền)">
                <span className="flex">
                  Độ mịn <span className="ml-auto tabular-nums">{soften} px</span>
                </span>
                <input type="range" min={1} max={8} value={soften} onChange={(e) => setSoften(Number(e.target.value))} />
              </label>
              <button onClick={smoothAll} disabled={!ready} className={side(false)} title="Làm mềm toàn bộ mép cắt của clipart này (bớt sắc, bớt răng cưa) — vẫn lùi được">
                <Sparkles className="h-4 w-4 shrink-0" />
                Làm mịn cả viền
                {keyTag("M")}
              </button>
            </div>
            <div className="flex flex-col gap-0.5 border-t pt-2">
              <button className={cx(side(false), "disabled:opacity-30")} disabled={changes <= 0 && undo.current.length === 0} onClick={() => step(true)}>
                <Undo2 className="h-4 w-4 shrink-0" />
                Lùi
                {keyTag(`${MOD}Z`)}
              </button>
              <button className={cx(side(false), "disabled:opacity-30")} disabled={!canRedo} onClick={() => step(false)}>
                <Redo2 className="h-4 w-4 shrink-0" />
                Tới
                {keyTag(`⇧${MOD}Z`)}
              </button>
            </div>
            {props.sidebar && <div className="border-t pt-2">{props.sidebar(leave)}</div>}
          </div>
        )}
        <div
          ref={wrap}
          className="relative min-h-0 flex-1 touch-none overflow-hidden"
          style={{ ...CHECKER_STYLE, cursor }}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onContextMenu={(e) => e.preventDefault()}
        >
          {!ready && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
              {loadError ?? (
                <span className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" /> Đang tải ảnh {W}×{H}…
                </span>
              )}
            </div>
          )}
          <div className="absolute left-0 top-0 origin-top-left" style={{ width: W, height: H, transform: `translate(${z.ox}px, ${z.oy}px) scale(${z.s})` }}>
            <canvas ref={view} width={W} height={H} className="block h-full w-full" style={{ imageRendering: z.s > 2 ? "pixelated" : "auto" }} />
          </div>
          {/* The brush: a white ring with a dark shadow — seen on light and dark pixels alike (asked 2026-10-14). */}
          {brushy && !props.readOnly && <div ref={ring} className={BRUSH_RING} />}
        </div>
        {(props.context?.length ?? 0) > 0 && (
          <div className="flex w-64 shrink-0 flex-col gap-1 overflow-y-auto border-l p-2">
            <div className="flex items-center text-[11px] font-medium text-muted-foreground">
              Xem trước — như ở 3c, đổi ngay khi sửa
            </div>
            <canvas
              ref={mini}
              width={480}
              height={Math.round((480 * H) / W)}
              className="w-full touch-none rounded border"
              style={{ ...CHECKER_STYLE, cursor: pz.s > 1 ? (pzPan.current ? "grabbing" : "grab") : "zoom-in" }}
              title="Lăn chuột / chụm 2 ngón = phóng to · kéo = di chuyển · bấm đúp = vừa khung"
              onPointerDown={(e) => {
                (e.target as HTMLElement).setPointerCapture(e.pointerId);
                pzPan.current = { sx: e.clientX, sy: e.clientY, fx: pz.fx, fy: pz.fy };
              }}
              onPointerMove={(e) => {
                const d = pzPan.current;
                if (d && pz.s > 1) setPz((cur) => ({ ...cur, fx: d.fx - (e.clientX - d.sx) / (perPx() * cur.s), fy: d.fy - (e.clientY - d.sy) / (perPx() * cur.s) }));
              }}
              onPointerUp={() => (pzPan.current = null)}
              onPointerCancel={() => (pzPan.current = null)}
              onDoubleClick={() => setPz((cur) => ({ ...cur, s: cur.s > 1 ? 1 : 5 }))}
            />
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <button className="rounded p-1 hover:bg-accent" onClick={() => zoomPreview(1 / 1.5)} title="Thu nhỏ">
                <Minus className="h-3.5 w-3.5" />
              </button>
              <button className="w-12 shrink-0 rounded px-1 py-0.5 tabular-nums hover:bg-accent" onClick={() => setPz((cur) => ({ ...cur, s: cur.s > 1 ? 1 : 5 }))} title="Vừa khung ↔ 500 %">
                {Math.round(pz.s * 100)}%
              </button>
              <button className="rounded p-1 hover:bg-accent" onClick={() => zoomPreview(1.5)} title="Phóng to">
                <Plus className="h-3.5 w-3.5" />
              </button>
              <span className="ml-1">theo con trỏ · lăn chuột / bấm đúp</span>
            </div>
          </div>
        )}
      </div>
      <div className="border-t px-3 py-1 text-[11px] text-muted-foreground">
        Lăn chuột / chụm 2 ngón = phóng to ảnh (zoom trình duyệt bị tắt khi đang sửa) · giữ Space hoặc nút giữa chuột = kéo ảnh
        {dirty && <span className="ml-2 font-medium text-foreground">{[changes > 0 && `${changes} thay đổi`, moved && `dời ${off.dx}, ${off.dy} px`].filter(Boolean).join(" · ")} chưa lưu</span>}
      </div>
    </div>
  );
}
