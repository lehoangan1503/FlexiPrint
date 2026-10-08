"use client";

/**
 * "Sửa nền" of the cut (server/char/cut.ts → layer-kit /matte/fix): the matte is shown on a dark backdrop, where
 * leftover paper shows white; the editor clicks each bit that is not clean, then "Xoá các chỗ đã chấm" — around
 * every point the server removes the stray bit or the paper (a small radius only). Each run is a saved version
 * ("Hoàn tác lần xoá trước" goes back one).
 *
 * Click = a point, click a point = remove it, drag = move the picture, wheel = zoom, Ctrl+Z = last point off.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Eraser, History, Loader2, Minus, Plus, Trash2, X } from "lucide-react";
import { CHECKER_STYLE, CtButton, cx } from "../ui";

export interface MattePoint {
  x: number;
  y: number;
}

export interface MatteFixProps {
  width: number;
  height: number;
  /** The matte's colours at print size. */
  colourUrl: string;
  /** Its alpha now (PNG: white, alpha = the matte). */
  alphaUrl: string;
  canRevert: boolean;
  readOnly?: boolean;
  onFix: (points: MattePoint[]) => Promise<void>;
  onRevert: () => Promise<void>;
  onClose: () => void;
}

type Backdrop = "dark" | "checker" | "light";

const BACKDROPS: Array<{ id: Backdrop; label: string; style: React.CSSProperties }> = [
  { id: "dark", label: "Nền tối", style: { background: "#141a2c" } },
  { id: "checker", label: "Ô cờ", style: CHECKER_STYLE },
  { id: "light", label: "Nền sáng", style: { background: "#f4f4f5" } },
];

/** Screen px within which a click hits an existing point (removes it). */
const HIT = 10;
/** Screen px a press may move and still be a click (more = dragging the picture). */
const DRAG = 4;

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("Không tải được ảnh"));
    im.src = src;
  });
}

export function MatteFix(props: MatteFixProps) {
  const { width: W, height: H } = props;
  const wrap = useRef<HTMLDivElement | null>(null);
  const view = useRef<HTMLCanvasElement | null>(null);
  const press = useRef<{ sx: number; sy: number; ox: number; oy: number; drag: boolean } | null>(null);
  const [ready, setReady] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [z, setZ] = useState({ s: 0.2, ox: 0, oy: 0 });
  const [points, setPoints] = useState<MattePoint[]>([]);
  const [backdrop, setBackdrop] = useState<Backdrop>("dark");
  const [busy, setBusy] = useState<"fix" | "revert" | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const colour = useRef<HTMLImageElement | null>(null);

  // ---- load: the colours once, the alpha each time it changes (after a fix / a revert) ----
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [c, a] = await Promise.all([colour.current ? Promise.resolve(colour.current) : loadImg(props.colourUrl), loadImg(props.alphaUrl)]);
        if (!live || !view.current) return;
        colour.current = c;
        const g = view.current.getContext("2d")!;
        g.globalCompositeOperation = "source-over";
        g.clearRect(0, 0, W, H);
        g.drawImage(c, 0, 0, W, H);
        g.globalCompositeOperation = "destination-in";
        g.drawImage(a, 0, 0, W, H);
        g.globalCompositeOperation = "source-over";
        setShown(props.alphaUrl);
        setReady(true);
      } catch (e) {
        if (live) setLoadError(e instanceof Error ? e.message : "Không tải được ảnh");
      }
    })();
    return () => {
      live = false;
    };
  }, [props.colourUrl, props.alphaUrl, W, H]);

  const fitView = useCallback(() => {
    const el = wrap.current;
    if (!el) return;
    const s = Math.min(el.clientWidth / W, el.clientHeight / H) * 0.96;
    setZ({ s, ox: (el.clientWidth - W * s) / 2, oy: (el.clientHeight - H * s) / 2 });
  }, [W, H]);
  const fitted = useRef(false);
  useEffect(() => {
    if (ready && !fitted.current) {
      fitted.current = true;
      fitView();
    }
  }, [ready, fitView]);

  // ---- pointer ----
  const local = (e: { clientX: number; clientY: number }) => {
    const r = wrap.current!.getBoundingClientRect();
    return { mx: e.clientX - r.left, my: e.clientY - r.top };
  };

  const down = (e: React.PointerEvent) => {
    if (!ready) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    press.current = { sx: e.clientX, sy: e.clientY, ox: z.ox, oy: z.oy, drag: e.button === 1 };
  };

  const move = (e: React.PointerEvent) => {
    const p = press.current;
    if (!p) return;
    if (!p.drag && Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > DRAG) p.drag = true;
    if (p.drag) setZ((cur) => ({ ...cur, ox: p.ox + e.clientX - p.sx, oy: p.oy + e.clientY - p.sy }));
  };

  const up = (e: React.PointerEvent) => {
    const p = press.current;
    press.current = null;
    if (!p || p.drag || e.button !== 0 || props.readOnly || busy) return;
    const { mx, my } = local(e);
    const x = (mx - z.ox) / z.s;
    const y = (my - z.oy) / z.s;
    const hit = points.findIndex((q) => Math.hypot(q.x * z.s + z.ox - mx, q.y * z.s + z.oy - my) <= HIT);
    if (hit >= 0) return setPoints((cur) => cur.filter((_, i) => i !== hit));
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    setMsg(null);
    setPoints((cur) => [...cur, { x: Math.round(x), y: Math.round(y) }]);
  };

  const zoomAt = (mx: number, my: number, k: number) =>
    setZ((cur) => {
      const s = Math.min(16, Math.max(0.05, cur.s * k));
      return { s, ox: mx - ((mx - cur.ox) * s) / cur.s, oy: my - ((my - cur.oy) * s) / cur.s };
    });

  const wheel = (e: React.WheelEvent) => {
    const { mx, my } = local(e);
    zoomAt(mx, my, e.deltaY < 0 ? 1.15 : 1 / 1.15);
  };

  const zoomBy = (k: number) => {
    const el = wrap.current;
    if (el) zoomAt(el.clientWidth / 2, el.clientHeight / 2, k);
  };

  // ---- actions ----
  const fix = async () => {
    if (!points.length) return;
    setBusy("fix");
    setMsg(null);
    try {
      await props.onFix(points);
      setMsg({ ok: true, text: `Đã xoá quanh ${points.length} điểm — xem lại, còn sót thì chấm tiếp` });
      setPoints([]);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Không xoá được" });
    } finally {
      setBusy(null);
    }
  };

  const revert = async () => {
    if (!window.confirm("Quay về bản trước lần xoá vừa rồi?")) return;
    setBusy("revert");
    setMsg(null);
    try {
      await props.onRevert();
      setMsg({ ok: true, text: "Đã quay về bản trước" });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Không hoàn tác được" });
    } finally {
      setBusy(null);
    }
  };

  const close = () => {
    if (points.length > 0 && !window.confirm("Bỏ các điểm đã chấm mà chưa xoá?")) return;
    props.onClose();
  };

  // ---- keys ----
  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        setPoints((cur) => cur.slice(0, -1));
      }
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", kd);
    return () => window.removeEventListener("keydown", kd);
  });

  const bg = BACKDROPS.find((b) => b.id === backdrop)!;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <div className="mr-2 min-w-0">
          <div className="truncate text-sm font-semibold">Sửa nền</div>
          <div className="truncate text-[11px] text-muted-foreground">
            Chấm vào từng chỗ nền còn sót (mảng trắng, mảnh rời) rồi bấm Xoá — hệ thống phân tích quanh mỗi điểm và xoá phần nền ở đó.
          </div>
        </div>
        <div className="flex items-center gap-1 rounded-md border p-0.5 text-xs">
          {BACKDROPS.map((b) => (
            <button key={b.id} onClick={() => setBackdrop(b.id)} className={cx("rounded px-2 py-1", backdrop === b.id ? "bg-foreground text-background" : "hover:bg-accent")}>
              {b.label}
            </button>
          ))}
        </div>
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
          {msg && (
            <span className={cx("max-w-sm truncate text-xs", msg.ok ? "text-emerald-600" : "text-destructive")} title={msg.text}>
              {msg.text}
            </span>
          )}
          {!props.readOnly && points.length > 0 && (
            <CtButton disabled={!!busy} onClick={() => setPoints([])} title="Bỏ hết các điểm đã chấm">
              <Trash2 className="h-4 w-4" /> Bỏ điểm
            </CtButton>
          )}
          {!props.readOnly && props.canRevert && (
            <CtButton disabled={!!busy} onClick={() => void revert()} title="Quay về bản trước lần xoá vừa rồi (server giữ 5 bản)">
              {busy === "revert" ? <Loader2 className="h-4 w-4 animate-spin" /> : <History className="h-4 w-4" />}
              Hoàn tác lần xoá trước
            </CtButton>
          )}
          {!props.readOnly && (
            <CtButton variant="primary" disabled={!!busy || points.length === 0} onClick={() => void fix()}>
              {busy === "fix" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eraser className="h-4 w-4" />}
              Xoá các chỗ đã chấm{points.length ? ` (${points.length})` : ""}
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
        style={{ ...bg.style, cursor: props.readOnly ? "grab" : "crosshair" }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={() => (press.current = null)}
        onWheel={wheel}
        onContextMenu={(e) => e.preventDefault()}
      >
        {(!ready || shown !== props.alphaUrl) && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center text-sm text-muted-foreground">
            {loadError ?? (
              <span className="flex items-center gap-2 rounded bg-background/80 px-3 py-1.5">
                <Loader2 className="h-4 w-4 animate-spin" /> Đang tải ảnh {W}×{H}…
              </span>
            )}
          </div>
        )}
        <div className="absolute left-0 top-0 origin-top-left" style={{ width: W, height: H, transform: `translate(${z.ox}px, ${z.oy}px) scale(${z.s})` }}>
          <canvas ref={view} width={W} height={H} className="block h-full w-full" style={{ imageRendering: z.s > 2 ? "pixelated" : "auto" }} />
        </div>
        {points.map((p, i) => (
          <div
            key={`${p.x}:${p.y}:${i}`}
            className="pointer-events-none absolute left-0 top-0 h-3.5 w-3.5 rounded-full border-2 border-white bg-red-500 shadow"
            style={{ transform: `translate(${p.x * z.s + z.ox - 7}px, ${p.y * z.s + z.oy - 7}px)` }}
          />
        ))}
        {busy === "fix" && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="flex items-center gap-2 rounded bg-background/90 px-3 py-1.5 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Đang phân tích và xoá quanh {points.length} điểm…
            </span>
          </div>
        )}
      </div>
      <div className="border-t px-3 py-1 text-[11px] text-muted-foreground">
        Bấm = chấm điểm · bấm vào điểm = bỏ điểm · kéo = di chuyển ảnh · lăn chuột = phóng to · Ctrl+Z bỏ điểm cuối · Esc đóng
        {points.length > 0 && <span className="ml-2 font-medium text-foreground">{points.length} điểm chưa xoá</span>}
      </div>
    </div>
  );
}
