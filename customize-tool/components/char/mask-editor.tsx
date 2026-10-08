"use client";

/**
 * Full-screen mask editor of the cut (server/char/cut.ts): the master's backdrop (mode "matte") or one layer's
 * region on its picture (mode "region"). The mask is a canvas the size of the picture (white, alpha = the mask)
 * and every tool adds to it or takes from it:
 *   Cọ       brush (size, hardness) — a click is a dot
 *   Vùng     lasso: draw round an area, it is filled
 *   Đũa thần magic wand on the picture's colours (tolerance, contiguous or everywhere) — like Photoshop
 *   Mảng     a whole island of the mask (remove a stray bit) / a whole hole inside it (fill)
 *   Tay      pan (also: hold Space, or the middle button); wheel = zoom
 * Thêm / Bớt switches what a tool does (hold Alt for the other one). Undo / redo (Ctrl+Z / Ctrl+Shift+Z) keep the
 * changed rectangle only, so a long session stays light. "Lưu" sends the mask as PNG; the server keeps 5 versions.
 *
 * Pictures come from the storage domain with CORS (crossOrigin) — the wand reads the picture's pixels.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Brush, Eye, Hand, Lasso, Loader2, Minus, Plus, Redo2, Save, Sparkles, Undo2, Wand2, X, History } from "lucide-react";
import { CHECKER_STYLE, CtButton, cx } from "../ui";

export type MaskEditorMode = "matte" | "region";
type Tool = "brush" | "lasso" | "wand" | "island" | "hand";
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
  /** region mode: the picture's subject alpha — the result view shows region × subject (what the file will be). */
  subjectUrl?: string | null;
  mode: MaskEditorMode;
  /** region mode: highlight colour. */
  tint?: string;
  /** Other regions on the same picture, shown faintly for context. */
  others?: Array<{ url: string; color: string; label: string }>;
  canRevert: boolean;
  readOnly?: boolean;
  onSave: (png: string) => Promise<void>;
  onRevert: () => Promise<void>;
  onClose: () => void;
}

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
  { id: "hand", label: "Tay", key: "H", icon: Hand, tip: "Kéo để di chuyển (hoặc giữ Space)" },
];

export function MaskEditor(props: MaskEditorProps) {
  const { width: W, height: H, mode } = props;
  const tint = props.tint ?? "#f97316";
  const wrap = useRef<HTMLDivElement | null>(null);
  const view = useRef<HTMLCanvasElement | null>(null);
  const ring = useRef<HTMLDivElement | null>(null);
  const store = useRef<{
    colour: HTMLImageElement;
    subject: HTMLImageElement | null;
    others: Array<{ img: HTMLImageElement; color: string }>;
    mask: HTMLCanvasElement;
    committed: HTMLCanvasElement;
    tmp: HTMLCanvasElement;
    pixels: Uint8ClampedArray | null;
  } | null>(null);
  const undo = useRef<Patch[]>([]);
  const redo = useRef<Patch[]>([]);
  const stroke = useRef<{ last: { x: number; y: number } | null; box: Box | null; lasso: Array<[number, number]> } | null>(null);
  const pan = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const frame = useRef(0);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("brush");
  const [op, setOp] = useState<Op>(mode === "matte" ? "remove" : "add");
  const [alt, setAlt] = useState(false);
  const [space, setSpace] = useState(false);
  const [size, setSize] = useState(40);
  const [hard, setHard] = useState(0.8);
  const [tol, setTol] = useState(18);
  const [contiguous, setContiguous] = useState(true);
  const [viewMode, setViewMode] = useState<View>(mode === "matte" ? "result" : "overlay");
  const [ghost, setGhost] = useState(true);
  const [showOthers, setShowOthers] = useState(true);
  const [z, setZ] = useState({ s: 0.2, ox: 0, oy: 0 });
  const [changes, setChanges] = useState(0);
  const [canRedo, setCanRedo] = useState(false);
  const [busy, setBusy] = useState<"save" | "revert" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const effOp: Op = alt ? (op === "add" ? "remove" : "add") : op;
  const effTool: Tool = space ? "hand" : tool;

  // ---- load ----
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [colour, maskImg, subject, others] = await Promise.all([
          loadImg(props.colourUrl),
          loadImg(props.maskUrl),
          props.subjectUrl ? loadImg(props.subjectUrl) : Promise.resolve(null),
          Promise.all((props.others ?? []).map(async (o) => ({ img: await loadImg(o.url), color: o.color }))),
        ]);
        if (!live) return;
        const mask = canvas(W, H);
        ctx2d(mask).drawImage(maskImg, 0, 0, W, H);
        const committed = canvas(W, H);
        ctx2d(committed).drawImage(mask, 0, 0);
        store.current = { colour, subject, others, mask, committed, tmp: canvas(W, H), pixels: null };
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
  useEffect(() => {
    if (ready) fitView();
  }, [ready, fitView]);

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
    const tinted = (src: CanvasImageSource, color: string, alpha: number, inverse = false) => {
      t.globalCompositeOperation = "source-over";
      t.clearRect(0, 0, W, H);
      if (inverse) {
        t.fillStyle = color;
        t.fillRect(0, 0, W, H);
        t.globalCompositeOperation = "destination-out";
        t.drawImage(src, 0, 0, W, H);
      } else {
        t.drawImage(src, 0, 0, W, H);
        t.globalCompositeOperation = "source-in";
        t.fillStyle = color;
        t.fillRect(0, 0, W, H);
      }
      t.globalCompositeOperation = "source-over";
      g.globalAlpha = alpha;
      g.drawImage(st.tmp, 0, 0);
      g.globalAlpha = 1;
    };
    if (viewMode === "result") {
      if (ghost) {
        g.globalAlpha = 0.16;
        g.drawImage(st.colour, 0, 0, W, H);
        g.globalAlpha = 1;
      }
      t.globalCompositeOperation = "source-over";
      t.clearRect(0, 0, W, H);
      t.drawImage(st.colour, 0, 0, W, H);
      t.globalCompositeOperation = "destination-in";
      t.drawImage(st.mask, 0, 0);
      if (st.subject) t.drawImage(st.subject, 0, 0, W, H);
      t.globalCompositeOperation = "source-over";
      g.drawImage(st.tmp, 0, 0);
    } else {
      g.drawImage(st.colour, 0, 0, W, H);
      if (mode === "matte") {
        // What is cut away shows red.
        tinted(st.mask, "#ef4444", 0.5, true);
      } else {
        if (showOthers) for (const o of st.others) tinted(o.img, o.color, 0.28);
        tinted(st.mask, tint, 0.55);
      }
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
  }, [W, H, viewMode, ghost, showOthers, mode, tint, z.s, effOp]);

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
    for (let i = 1; i <= n; i++) stamp(a.x + ((b.x - a.x) * i) / n, a.y + ((b.y - a.y) * i) / n);
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
  const at = (e: { clientX: number; clientY: number }) => {
    const r = view.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
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
    schedule();
  };

  const move = (e: React.PointerEvent) => {
    moveRing(e);
    if (pan.current) {
      const pn = pan.current;
      setZ((cur) => ({ ...cur, ox: pn.ox + e.clientX - pn.sx, oy: pn.oy + e.clientY - pn.sy }));
      return;
    }
    const s = stroke.current;
    if (!s) return;
    const p = at(e);
    if (effTool === "brush" && s.last) {
      line(s.last, p);
      s.last = p;
    } else if (effTool === "lasso") s.lasso.push([p.x, p.y]);
    schedule();
  };

  const up = () => {
    if (pan.current) {
      pan.current = null;
      return;
    }
    const s = stroke.current;
    if (!s) return;
    const box = effTool === "lasso" ? fillLasso(s.lasso) : s.box;
    stroke.current = null;
    commit(box);
    schedule();
  };

  const wheel = (e: React.WheelEvent) => {
    const box = wrap.current!.getBoundingClientRect();
    const mx = e.clientX - box.left;
    const my = e.clientY - box.top;
    const k = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setZ((cur) => {
      const s = Math.min(16, Math.max(0.05, cur.s * k));
      return { s, ox: mx - ((mx - cur.ox) * s) / cur.s, oy: my - ((my - cur.oy) * s) / cur.s };
    });
  };

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
      if (e.metaKey || e.ctrlKey) return;
      const t = TOOLS.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
      if (t) setTool(t.id);
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

  const save = async () => {
    const st = store.current;
    if (!st) return;
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
      await props.onSave(url);
      props.onClose();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Không lưu được");
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

  const close = () => {
    if (changes > 0 && !window.confirm("Bỏ các thay đổi chưa lưu?")) return;
    props.onClose();
  };

  const cursor = effTool === "hand" ? (pan.current ? "grabbing" : "grab") : effTool === "brush" ? "none" : "crosshair";

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <div className="mr-2 min-w-0">
          <div className="truncate text-sm font-semibold">{props.title}</div>
          {props.hint && <div className="truncate text-[11px] text-muted-foreground">{props.hint}</div>}
        </div>
        {!props.readOnly && (
          <>
            <div className="flex rounded-md border p-0.5">
              {TOOLS.map((t) => (
                <button
                  key={t.id}
                  title={`${t.tip} (${t.key})`}
                  onClick={() => setTool(t.id)}
                  className={cx("flex items-center gap-1 rounded px-2 py-1 text-xs", effTool === t.id ? "bg-foreground text-background" : "hover:bg-accent")}
                >
                  <t.icon className="h-3.5 w-3.5" />
                  {t.label}
                </button>
              ))}
            </div>
            {effTool !== "hand" && (
              <div className="flex rounded-md border p-0.5" title="X để đổi, giữ Alt để dùng tạm cái kia">
                <button onClick={() => setOp("add")} className={cx("flex items-center gap-1 rounded px-2 py-1 text-xs", effOp === "add" ? "bg-emerald-600 text-white" : "hover:bg-accent")}>
                  <Plus className="h-3.5 w-3.5" />
                  {mode === "matte" ? "Giữ lại" : "Thêm vào lớp"}
                </button>
                <button onClick={() => setOp("remove")} className={cx("flex items-center gap-1 rounded px-2 py-1 text-xs", effOp === "remove" ? "bg-red-600 text-white" : "hover:bg-accent")}>
                  <Minus className="h-3.5 w-3.5" />
                  {mode === "matte" ? "Xoá (thành nền)" : "Bớt khỏi lớp"}
                </button>
              </div>
            )}
            {effTool === "brush" && (
              <>
                <label className="flex items-center gap-1 text-xs">
                  Cỡ
                  <input type="range" min={2} max={400} value={size} onChange={(e) => setSize(Number(e.target.value))} className="w-24" />
                  <span className="w-8 tabular-nums">{size}</span>
                </label>
                <label className="flex items-center gap-1 text-xs" title="Viền cọ: mềm ↔ cứng">
                  Độ cứng
                  <input type="range" min={0} max={100} value={Math.round(hard * 100)} onChange={(e) => setHard(Number(e.target.value) / 100)} className="w-20" />
                </label>
              </>
            )}
            {effTool === "wand" && (
              <>
                <label className="flex items-center gap-1 text-xs" title="Độ lệch màu được chọn chung">
                  Dung sai
                  <input type="range" min={1} max={80} value={tol} onChange={(e) => setTol(Number(e.target.value))} className="w-24" />
                  <span className="w-6 tabular-nums">{tol}</span>
                </label>
                <label className="flex items-center gap-1 text-xs" title="Bỏ chọn = mọi chỗ cùng màu trong ảnh">
                  <input type="checkbox" checked={contiguous} onChange={(e) => setContiguous(e.target.checked)} />
                  Liền mạch
                </label>
              </>
            )}
            <div className="flex items-center gap-0.5">
              <button className="rounded p-1.5 hover:bg-accent disabled:opacity-30" disabled={changes <= 0 && undo.current.length === 0} onClick={() => step(true)} title="Lùi (Ctrl+Z)">
                <Undo2 className="h-4 w-4" />
              </button>
              <button className="rounded p-1.5 hover:bg-accent disabled:opacity-30" disabled={!canRedo} onClick={() => step(false)} title="Tới (Ctrl+Shift+Z)">
                <Redo2 className="h-4 w-4" />
              </button>
            </div>
          </>
        )}
        <div className="flex items-center gap-1 rounded-md border p-0.5 text-xs">
          <button onClick={() => setViewMode("result")} className={cx("rounded px-2 py-1", viewMode === "result" ? "bg-foreground text-background" : "hover:bg-accent")} title="Xem kết quả cắt trên nền ô cờ">
            Kết quả
          </button>
          <button onClick={() => setViewMode("overlay")} className={cx("rounded px-2 py-1", viewMode === "overlay" ? "bg-foreground text-background" : "hover:bg-accent")} title={mode === "matte" ? "Ảnh gốc, phần bị xoá tô đỏ" : "Ảnh gốc, vùng của lớp tô màu"}>
            {mode === "matte" ? "Tô đỏ phần xoá" : "Tô màu vùng"}
          </button>
        </div>
        {viewMode === "result" ? (
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={ghost} onChange={(e) => setGhost(e.target.checked)} />
            <Eye className="h-3.5 w-3.5" /> Ảnh mờ phía sau
          </label>
        ) : (
          mode === "region" &&
          (props.others?.length ?? 0) > 0 && (
            <label className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={showOthers} onChange={(e) => setShowOthers(e.target.checked)} />
              Các lớp khác
            </label>
          )
        )}
        <div className="flex items-center gap-0.5 text-xs">
          <button className="rounded p-1 hover:bg-accent" onClick={() => zoomBy(1 / 1.3)}>
            <Minus className="h-3.5 w-3.5" />
          </button>
          <button className="w-12 rounded px-1 py-0.5 tabular-nums hover:bg-accent" onClick={fitView} title="Vừa khung">
            {Math.round(z.s * 100)}%
          </button>
          <button className="rounded p-1 hover:bg-accent" onClick={() => zoomBy(1.3)}>
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {msg && <span className="max-w-xs truncate text-xs text-destructive" title={msg}>{msg}</span>}
          {!props.readOnly && props.canRevert && (
            <CtButton disabled={!!busy} onClick={() => void revert()} title="Quay về bản đã lưu trước đó (server giữ 5 bản)">
              {busy === "revert" ? <Loader2 className="h-4 w-4 animate-spin" /> : <History className="h-4 w-4" />}
              Bản lưu trước
            </CtButton>
          )}
          {!props.readOnly && (
            <CtButton variant="primary" disabled={!!busy || changes === 0} onClick={() => void save()}>
              {busy === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Lưu
            </CtButton>
          )}
          <button className="rounded p-1.5 hover:bg-accent" onClick={close} title="Đóng (Esc)">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div
        ref={wrap}
        className="relative min-h-0 flex-1 touch-none overflow-hidden"
        style={{ ...CHECKER_STYLE, cursor }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onWheel={wheel}
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
        {effTool === "brush" && !props.readOnly && (
          <div ref={ring} className="pointer-events-none absolute left-0 top-0 rounded-full border border-white mix-blend-difference" />
        )}
      </div>
      <div className="border-t px-3 py-1 text-[11px] text-muted-foreground">
        Phím: B cọ · L vùng · W đũa thần · I mảng · H tay (hoặc giữ Space) · X đổi Thêm/Bớt (giữ Alt = tạm đổi) · [ ] cỡ cọ · lăn chuột = phóng to · Ctrl+Z lùi · Ctrl+Shift+Z tới · Esc đóng
        {changes > 0 && <span className="ml-2 font-medium text-foreground">{changes} thay đổi chưa lưu</span>}
      </div>
    </div>
  );
}
