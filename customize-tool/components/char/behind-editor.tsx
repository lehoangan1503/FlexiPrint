"use client";

/**
 * "Đưa 1 phần ra sau" (server/char/behind.ts) on the WHOLE artwork (asked 2026-10-23: "hiện full artwork, kết quả phải
 * là artwork hoàn chỉnh với layer đã ra sau", the dimmed picture behind the old editor was not understood). The parent's
 * biggest version is drawn as it will be printed: every copy of the layer × the mask under everything, then the
 * product's layers back → front with each copy × (1 − mask) in its place — so what the editor sees while drawing IS the
 * result. The mask lives on the pose's canvas; a stroke on any copy (mirrored ones too) draws on it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Brush, Hand, Lasso, Loader2, Minus, Plus, Redo2, Save, Trash2, Undo2, X } from "lucide-react";
import type { CtBehindStage, CtCharLayerSet, CtCharLayerSlot } from "../../types";
import { CHECKER_STYLE, CtButton, cx } from "../ui";
import { useNoBrowserZoom } from "./no-browser-zoom";
import { BRUSH_RING, BRUSH_RING_STYLE } from "./mask-editor";

type Tool = "lasso" | "brush" | "hand";
type Op = "add" | "remove";
type Box = { x: number; y: number; w: number; h: number };

const MAX_SIDE = 1100;
const UNDO = 30;

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

const ctx2d = (c: HTMLCanvasElement) => c.getContext("2d")!;

/** A copy's canvas drawn into its box (mirrored copies flipped). */
function place(g: CanvasRenderingContext2D, src: CanvasImageSource, box: Box, flip: boolean | undefined) {
  g.save();
  if (flip) {
    g.translate(box.x + box.w, box.y);
    g.scale(-1, 1);
    g.drawImage(src, 0, 0, box.w, box.h);
  } else g.drawImage(src, box.x, box.y, box.w, box.h);
  g.restore();
}

export function BehindEditor(props: {
  title: string;
  set: CtCharLayerSet;
  slot: CtCharLayerSlot;
  load: () => Promise<CtBehindStage>;
  readOnly: boolean;
  onSave: (png: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const { set } = props;
  const [stage, setStage] = useState<CtBehindStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("lasso");
  const [op, setOp] = useState<Op>("add");
  const [size, setSize] = useState(30);
  const [tint, setTint] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(0);
  const [hist, setHist] = useState({ undo: 0, redo: 0 });
  const [z, setZ] = useState({ s: 1, ox: 0, oy: 0 });
  const [lasso, setLasso] = useState<Array<[number, number]>>([]);
  const view = useRef<HTMLCanvasElement | null>(null);
  const ring = useRef<HTMLDivElement | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);
  const store = useRef<{
    plates: Array<{ img: HTMLImageElement | null; box?: Box; flip?: boolean; layer?: HTMLImageElement }>;
    mask: HTMLCanvasElement;
    /** The mask grown ~3 px with a hard edge: the back part reaches under the front part's soft edge (like the
     * server's — two soft halves left a dotted see-through seam, 2026-10-23). */
    grown: HTMLCanvasElement;
    tmp: HTMLCanvasElement;
    undo: ImageData[];
    redo: ImageData[];
  } | null>(null);
  const stroke = useRef<{ copy: number; last: [number, number] | null; pan?: { sx: number; sy: number; ox: number; oy: number } } | null>(null);

  // The mask at most MAX_SIDE on its long side (the server scales it back to the canvas).
  const q = Math.min(1, MAX_SIDE / Math.max(set.width, set.height));
  const MW = Math.round(set.width * q);
  const MH = Math.round(set.height * q);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const st = await props.load();
        const pics = new Map<string, Promise<HTMLImageElement>>();
        const pic = (u: string) => pics.get(u) ?? pics.set(u, loadImg(u)).get(u)!;
        const [plates, old] = await Promise.all([
          Promise.all(st.plates.map(async (p) => ({ img: p.url ? await pic(p.url) : null, box: p.box, flip: p.flip, layer: p.layerUrl ? await pic(p.layerUrl) : undefined }))),
          props.slot.behindUrl ? loadImg(props.slot.behindUrl).catch(() => null) : Promise.resolve(null),
        ]);
        if (!live) return;
        const mask = canvas(MW, MH);
        if (old) ctx2d(mask).drawImage(old, 0, 0, MW, MH);
        store.current = { plates, mask, grown: canvas(MW, MH), tmp: canvas(MW, MH), undo: [], redo: [] };
        setStage(st);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : "Không dựng được artwork");
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- the finished artwork, live ----
  const render = useCallback(() => {
    const st = store.current;
    const c = view.current;
    if (!st || !c) return;
    const g = ctx2d(c);
    const t = ctx2d(st.tmp);
    g.clearRect(0, 0, c.width, c.height);
    // The grown mask: drawn shifted around a ring and stacked until any coverage is full.
    const gr = ctx2d(st.grown);
    gr.clearRect(0, 0, MW, MH);
    const R = Math.max(2, Math.round(3 * q));
    for (let pass = 0; pass < 3; pass++)
      for (let a = 0; a < 16; a++) {
        const ang = (a / 16) * Math.PI * 2;
        gr.drawImage(st.mask, Math.cos(ang) * R, Math.sin(ang) * R);
      }
    const masked = (layer: HTMLImageElement | undefined, mode: GlobalCompositeOperation, grown = false) => {
      t.globalCompositeOperation = "source-over";
      t.clearRect(0, 0, MW, MH);
      if (layer) t.drawImage(layer, 0, 0, MW, MH);
      t.globalCompositeOperation = mode;
      t.drawImage(grown ? st.grown : st.mask, 0, 0);
      t.globalCompositeOperation = "source-over";
    };
    const copies = st.plates.filter((p) => p.box);
    // 1) the part that goes behind: under everything (grown under the front part's edge).
    for (const p of copies) {
      masked(p.layer, "destination-in", true);
      place(g, st.tmp, p.box!, p.flip);
    }
    // 2) the product's layers back → front, each copy without its back part.
    for (const p of st.plates) {
      if (p.img) g.drawImage(p.img, 0, 0, c.width, c.height);
      else if (p.box) {
        masked(p.layer, "destination-out");
        place(g, st.tmp, p.box, p.flip);
      }
    }
    // 3) where the back part is: orange over the layer (hat and sweater alike).
    if (tint)
      for (const p of copies) {
        masked(p.layer, "destination-in");
        t.globalCompositeOperation = "source-in";
        t.fillStyle = "rgba(249,115,22,0.55)";
        t.fillRect(0, 0, MW, MH);
        t.globalCompositeOperation = "source-over";
        place(g, st.tmp, p.box!, p.flip);
      }
  }, [MW, MH, tint, q]);

  useEffect(() => {
    if (stage) requestAnimationFrame(render);
  }, [stage, render, dirty]);

  // Fit the artwork in the view once it is there.
  useEffect(() => {
    const el = wrap.current;
    if (!stage || !el) return;
    const s = Math.min(el.clientWidth / stage.width, el.clientHeight / stage.height) * 0.96;
    setZ({ s, ox: (el.clientWidth - stage.width * s) / 2, oy: (el.clientHeight - stage.height * s) / 2 });
  }, [stage]);

  /** A point on the artwork → the copy it is on (the front-most) and the point on the mask. */
  const toMask = (x: number, y: number, copy?: number): { copy: number; u: number; v: number } | null => {
    const st = store.current;
    if (!st) return null;
    const list = st.plates.map((p, i) => ({ p, i })).filter((x) => x.p.box);
    const hit = copy !== undefined ? list.find((c) => c.i === copy) : [...list].reverse().find(({ p }) => x >= p.box!.x && x <= p.box!.x + p.box!.w && y >= p.box!.y && y <= p.box!.y + p.box!.h);
    if (!hit) return null;
    const b = hit.p.box!;
    let u = ((x - b.x) / b.w) * MW;
    if (hit.p.flip) u = MW - u;
    return { copy: hit.i, u, v: ((y - b.y) / b.h) * MH };
  };

  const point = (e: React.PointerEvent): [number, number] => {
    const r = wrap.current!.getBoundingClientRect();
    return [(e.clientX - r.left - z.ox) / z.s, (e.clientY - r.top - z.oy) / z.s];
  };

  const snapshot = () => {
    const st = store.current!;
    st.undo.push(ctx2d(st.mask).getImageData(0, 0, MW, MH));
    if (st.undo.length > UNDO) st.undo.shift();
    st.redo = [];
    setHist({ undo: st.undo.length, redo: 0 });
  };

  const brushScale = () => {
    const b = store.current?.plates.find((p) => p.box)?.box;
    return b ? MW / b.w : 1;
  };

  const dab = (u: number, v: number) => {
    const m = ctx2d(store.current!.mask);
    m.globalCompositeOperation = op === "add" ? "source-over" : "destination-out";
    m.fillStyle = "#fff";
    m.beginPath();
    m.arc(u, v, (size / 2) * brushScale(), 0, Math.PI * 2);
    m.fill();
    m.globalCompositeOperation = "source-over";
  };

  const down = (e: React.PointerEvent) => {
    if (!stage) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const [x, y] = point(e);
    if (tool === "hand" || e.button === 1) {
      stroke.current = { copy: -1, last: null, pan: { sx: e.clientX, sy: e.clientY, ox: z.ox, oy: z.oy } };
      return;
    }
    if (props.readOnly) return;
    const at = toMask(x, y);
    if (!at) return;
    snapshot();
    stroke.current = { copy: at.copy, last: [x, y] };
    if (tool === "lasso") setLasso([[x, y]]);
    else {
      dab(at.u, at.v);
      setDirty((d) => d + 1);
    }
  };

  /** The brush's ring under the pointer, as big as the brush on screen. */
  const moveRing = (e: React.PointerEvent) => {
    const el = ring.current;
    const box = wrap.current?.getBoundingClientRect();
    if (!el || !box) return;
    const d = size * z.s;
    el.style.width = el.style.height = `${d}px`;
    el.style.transform = `translate(${e.clientX - box.left - d / 2}px, ${e.clientY - box.top - d / 2}px)`;
  };

  const move = (e: React.PointerEvent) => {
    moveRing(e);
    const s = stroke.current;
    if (!s) return;
    if (s.pan) {
      setZ((cur) => ({ ...cur, ox: s.pan!.ox + e.clientX - s.pan!.sx, oy: s.pan!.oy + e.clientY - s.pan!.sy }));
      return;
    }
    const [x, y] = point(e);
    if (tool === "lasso") {
      setLasso((l) => [...l, [x, y]]);
      return;
    }
    const [lx, ly] = s.last!;
    const n = Math.max(1, Math.ceil(Math.hypot(x - lx, y - ly) / Math.max(2, size / 4)));
    for (let i = 1; i <= n; i++) {
      const at = toMask(lx + ((x - lx) * i) / n, ly + ((y - ly) * i) / n, s.copy);
      if (at) dab(at.u, at.v);
    }
    s.last = [x, y];
    setDirty((d) => d + 1);
  };

  const up = () => {
    const s = stroke.current;
    stroke.current = null;
    if (!s || s.pan || tool !== "lasso") return;
    const pts = lasso.map(([x, y]) => toMask(x, y, s.copy)).filter((p): p is NonNullable<typeof p> => !!p);
    setLasso([]);
    if (pts.length < 3) return;
    const m = ctx2d(store.current!.mask);
    m.globalCompositeOperation = op === "add" ? "source-over" : "destination-out";
    m.fillStyle = "#fff";
    m.beginPath();
    pts.forEach((p, i) => (i ? m.lineTo(p.u, p.v) : m.moveTo(p.u, p.v)));
    m.closePath();
    m.fill();
    m.globalCompositeOperation = "source-over";
    setDirty((d) => d + 1);
  };

  const step = (back: boolean) => {
    const st = store.current;
    if (!st) return;
    const from = back ? st.undo : st.redo;
    const to = back ? st.redo : st.undo;
    const img = from.pop();
    if (!img) return;
    to.push(ctx2d(st.mask).getImageData(0, 0, MW, MH));
    ctx2d(st.mask).putImageData(img, 0, 0);
    setHist({ undo: st.undo.length, redo: st.redo.length });
    setDirty((d) => d + 1);
  };

  const clearAll = () => {
    if (!store.current) return;
    snapshot();
    ctx2d(store.current.mask).clearRect(0, 0, MW, MH);
    setDirty((d) => d + 1);
  };

  const save = async () => {
    const st = store.current;
    if (!st) return;
    setBusy(true);
    setError(null);
    try {
      const px = ctx2d(st.mask).getImageData(0, 0, MW, MH).data;
      let any = false;
      for (let i = 3; i < px.length; i += 4)
        if (px[i] > 8) {
          any = true;
          break;
        }
      await props.onSave(any ? st.mask.toDataURL("image/png") : null);
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không lưu được");
      setBusy(false);
    }
  };

  const zoomBy = (f: number, cx?: number, cy?: number) => {
    const el = wrap.current;
    if (!el) return;
    const px = cx ?? el.clientWidth / 2;
    const py = cy ?? el.clientHeight / 2;
    setZ((cur) => {
      const s = Math.min(12, Math.max(0.1, cur.s * f));
      return { s, ox: px - ((px - cur.ox) * s) / cur.s, oy: py - ((py - cur.oy) * s) / cur.s };
    });
  };  const fit = () => {
    const el = wrap.current;
    if (!stage || !el) return;
    const s = Math.min(el.clientWidth / stage.width, el.clientHeight / stage.height) * 0.96;
    setZ({ s, ox: (el.clientWidth - stage.width * s) / 2, oy: (el.clientHeight - stage.height * s) / 2 });
  };
  useNoBrowserZoom((k) => (k ? zoomBy(k) : fit()));


  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        step(!e.shiftKey);
      } else if (e.key === "Escape" && !busy) props.onClose();
      else if (e.key === "l") setTool("lasso");
      else if (e.key === "b") setTool("brush");
      else if (e.key === "h") setTool("hand");
      else if (e.key === "x") setOp((o) => (o === "add" ? "remove" : "add"));
    };
    window.addEventListener("keydown", kd);
    return () => window.removeEventListener("keydown", kd);
  });

  const toolBtn = (id: Tool, label: string, Icon: typeof Brush, key: string) => (
    <button key={id} onClick={() => setTool(id)} className={cx("flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm", tool === id ? "bg-foreground text-background" : "hover:bg-accent")}>
      <Icon className="h-4 w-4" /> {label} <span className="ml-auto text-[11px] opacity-60">({key})</span>
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-center gap-3 border-b px-3 py-2">
        <div className="mr-2 min-w-0">
          <div className="truncate text-sm font-semibold">{props.title}</div>
          <div className="truncate text-[11px] text-muted-foreground">Artwork hoàn chỉnh (bản đông người nhất) — đang hiện đúng như sẽ in. Tô / khoanh phần của layer phải nằm SAU người khác: phần đó chui xuống dưới ngay khi vẽ. Áp cho mọi theme và mọi nhân vật dùng dáng này.</div>
        </div>
        <label className="ml-auto flex items-center gap-1.5 whitespace-nowrap text-xs">
          <input type="checkbox" checked={tint} onChange={(e) => setTint(e.target.checked)} /> Tô cam phần nằm sau
        </label>
        <div className="flex items-center gap-0.5 text-xs">
          <button className="rounded p-1 hover:bg-accent" onClick={() => zoomBy(1 / 1.3)}>
            <Minus className="h-3.5 w-3.5" />
          </button>
          <span className="w-12 text-center tabular-nums">{Math.round(z.s * 100)}%</span>
          <button className="rounded p-1 hover:bg-accent" onClick={() => zoomBy(1.3)}>
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
        {error && <span className="max-w-xs truncate text-xs text-destructive" title={error}>{error}</span>}
        <CtButton variant="primary" disabled={busy || !stage || props.readOnly} onClick={() => void save()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Lưu
        </CtButton>
        <button className="rounded p-1.5 hover:bg-accent" onClick={props.onClose} title="Đóng (Esc)">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-48 shrink-0 flex-col gap-1 border-r p-2">
          {toolBtn("lasso", "Vùng", Lasso, "L")}
          {toolBtn("brush", "Cọ", Brush, "B")}
          {toolBtn("hand", "Tay", Hand, "H")}
          <div className="my-1 border-t" />
          <button onClick={() => setOp("add")} className={cx("flex items-center gap-2 rounded px-2 py-1.5 text-sm", op === "add" ? "bg-emerald-600 text-white" : "hover:bg-accent")}>
            <Plus className="h-4 w-4" /> Đưa ra sau
          </button>
          <button onClick={() => setOp("remove")} className={cx("flex items-center gap-2 rounded px-2 py-1.5 text-sm", op === "remove" ? "bg-red-600 text-white" : "hover:bg-accent")}>
            <Minus className="h-4 w-4" /> Trả về trước
          </button>
          <div className="text-[11px] text-muted-foreground">X = đổi</div>
          {tool === "brush" && (
            <label className="mt-1 text-xs">
              Cỡ cọ {size}
              <input type="range" min={4} max={120} value={size} onChange={(e) => setSize(+e.target.value)} className="w-full" />
            </label>
          )}
          <div className="my-1 border-t" />
          <button disabled={!hist.undo} onClick={() => step(true)} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent disabled:opacity-40">
            <Undo2 className="h-4 w-4" /> Lùi <span className="ml-auto text-[11px] opacity-60">⌘Z</span>
          </button>
          <button disabled={!hist.redo} onClick={() => step(false)} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent disabled:opacity-40">
            <Redo2 className="h-4 w-4" /> Tới
          </button>
          <button onClick={clearAll} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent">
            <Trash2 className="h-4 w-4" /> Bỏ hết
          </button>
        </div>
        <div
          ref={wrap}
          className="relative min-w-0 flex-1 touch-none overflow-hidden"
          style={{ ...CHECKER_STYLE, cursor: tool === "hand" ? "grab" : tool === "brush" ? "none" : "crosshair" }}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onWheel={(e) => {
            const r = wrap.current!.getBoundingClientRect();
            zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
          }}
        >
          {!stage && !error && (
            <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Đang dựng artwork hoàn chỉnh của sản phẩm…
            </div>
          )}
          {stage && tool === "brush" && !props.readOnly && <div ref={ring} className={BRUSH_RING} style={BRUSH_RING_STYLE} />}
          {stage && (
            <div className="absolute left-0 top-0 origin-top-left" style={{ width: stage.width, height: stage.height, transform: `translate(${z.ox}px, ${z.oy}px) scale(${z.s})` }}>
              <canvas ref={view} width={stage.width} height={stage.height} className="block h-full w-full" />
              {lasso.length > 1 && (
                <svg className="pointer-events-none absolute inset-0" width={stage.width} height={stage.height}>
                  <polygon points={lasso.map((p) => p.join(",")).join(" ")} fill={op === "add" ? "rgba(34,197,94,0.2)" : "rgba(239,68,68,0.2)"} stroke={op === "add" ? "#22c55e" : "#ef4444"} strokeWidth={2 / z.s} strokeDasharray={`${8 / z.s} ${6 / z.s}`} />
                </svg>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
