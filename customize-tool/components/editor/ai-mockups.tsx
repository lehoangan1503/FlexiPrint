"use client";

/**
 * Mockups tab (asked 2026-10-10: no hand editing): the finished artwork — the print file with the content chosen in
 * Thiết kế — laid on the phôi trơn, then AI photos of that product in fitting scenes (server/product-mockups.ts).
 *
 *   Phôi trơn   the blank piece the artwork goes on (Xem trước and mockups use it): uploaded / placed in "Phôi trơn"
 *               (the scene dialog), or made by AI from the khuôn in.
 *   Mockups     the front one (exact: the print on the phôi with its own shading) + one AI photo per scene line.
 *   Phôi + thiết kế  (asked 2026-10-29) the artwork chosen in Thiết kế laid on the phôi at its box, live — which
 *               product the mockups will be made of, before making them.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Sparkles, Trash2, Wallpaper } from "lucide-react";
import type { CtAsset, CtPackImage, CtProduct, CtProductConfig, CtRegion, CtRegionItem, CtSelection } from "../../types";
import { ctApi } from "../../lib/api-client";
import { canvasToBlob, renderComposite } from "../../lib/compositor";
import { displayAssets } from "../../lib/library";
import { ctConfirm } from "../dialogs";
import { CHECKER_STYLE, CtButton, CtTextarea, cx } from "../ui";

export interface AiMockupsPanelProps {
  product: CtProduct;
  main: CtAsset;
  assets: CtAsset[];
  regions: CtRegion[];
  items: CtRegionItem[];
  selection: CtSelection;
  config: CtProductConfig;
  /** Mockup pictures added to the product. */
  onAssets: (created: CtAsset[]) => void;
  onDelete: (asset: CtAsset) => Promise<void>;
  /** The product came back with a new phôi (config.scene). */
  onProduct: (p: CtProduct) => void;
  onOpenScene: () => void;
  flash: (msg: string) => void;
}

/** Longest side of the artwork drawn on the phôi + thiết kế picture. */
const ART_PREVIEW_SIDE = 700;

/** Scenes that suit the product, as a start (the editor rewrites them). */
function defaultScenes(name: string): string[] {
  const n = name.toLowerCase();
  if (/ornament/.test(n)) return ["hanging by a red satin ribbon on a decorated Christmas tree with warm fairy lights", "held in a hand in front of a cosy fireplace, soft bokeh", "flat lay on a wooden table with pine branches, pine cones and wrapped gifts"];
  if (/mug|cup|ly/.test(n)) return ["on a wooden breakfast table with coffee beans and morning light", "held in two hands by a window, cosy knit sweater"];
  if (/bag|túi|tote/.test(n)) return ["carried on the shoulder of a woman walking in a sunny street", "flat lay on a bed with a magazine and sunglasses"];
  return ["on a bright minimal table with soft daylight and a few matching props", "in a cosy home setting, warm natural light"];
}

export function AiMockupsPanel(props: AiMockupsPanelProps) {
  const { product, main, assets, regions, items, selection, config } = props;
  const [scenes, setScenes] = useState(() => defaultScenes(config.print?.name || product.name).join("\n"));
  const [jobs, setJobs] = useState<CtPackImage[]>([]);
  const [making, setMaking] = useState(false);
  const [blankBusy, setBlankBusy] = useState(false);
  const mockups = useMemo(() => assets.filter((a) => a.role === "mockup" && a.product_id === product.id).sort((a, b) => b.created_at.localeCompare(a.created_at)), [assets, product.id]);
  const running = jobs.filter((j) => j.status === "running");
  const [art, setArt] = useState<string | null>(null);

  // The finished artwork (what "Tạo mockup" sends) at preview size, for the phôi + thiết kế picture.
  useEffect(() => {
    let live = true;
    let url = "";
    const t = setTimeout(async () => {
      try {
        const scale = Math.min(1, ART_PREVIEW_SIDE / Math.max(1, main.width, main.height));
        const canvas = await renderComposite({ main, assets: displayAssets(assets, "flat"), regions, items, selection, scale, layouts: config.layouts, cutToFrame: true });
        url = URL.createObjectURL(await canvasToBlob(canvas, "image/png"));
        if (!live) return URL.revokeObjectURL(url);
        setArt((old) => {
          if (old) URL.revokeObjectURL(old);
          return url;
        });
      } catch {
        // Only a preview.
      }
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [main, assets, regions, items, selection, config.layouts]);

  const loadJobs = useCallback(async () => {
    try {
      setJobs(await ctApi.mockupJobs(product.id));
    } catch {
      // The list is only a progress view.
    }
  }, [product.id]);

  useEffect(() => {
    const t = setTimeout(() => void loadJobs(), 0);
    return () => clearTimeout(t);
  }, [loadJobs]);

  // While AI photos are being made: poll, and add each finished one to the product's pictures.
  useEffect(() => {
    if (!running.length) return;
    const t = setInterval(async () => {
      await loadJobs();
      try {
        const b = await ctApi.getBundle(product.id);
        props.onAssets(b.assets.filter((a) => a.role === "mockup" && a.product_id === product.id));
      } catch {
        // Next round.
      }
    }, 5000);
    return () => clearInterval(t);
    // props.onAssets is a fresh closure each render; the poll only needs the product.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running.length, loadJobs, product.id]);

  const make = async () => {
    setMaking(true);
    try {
      // The finished artwork: the print file (whole edit frame cut to the khuôn) — the phôi is blank, everything
      // printed goes on it.
      const canvas = await renderComposite({ main, assets: displayAssets(assets, "flat"), regions, items, selection, scale: 1, layouts: config.layouts, cutToFrame: true });
      const blob = await canvasToBlob(canvas, "image/png");
      const lines = scenes.split("\n").map((l) => l.trim()).filter(Boolean);
      const r = await ctApi.makeMockups(product.id, blob, lines);
      setJobs((cur) => [...r.jobs, ...cur.filter((j) => !r.jobs.some((x) => x.id === j.id))]);
      props.flash(`AI đang tạo ${lines.length || 1} ảnh bối cảnh từ artwork trên phôi (1–2 phút / ảnh)`);
    } catch (e) {
      props.flash(e instanceof Error ? e.message : "Không tạo được mockup");
    } finally {
      setMaking(false);
    }
  };

  const makeBlank = async () => {
    if (config.scene.url && !(await ctConfirm({ title: "Tạo phôi mới bằng AI?", message: "Phôi hiện tại được thay bằng phôi AI vẽ theo khuôn in.", confirmLabel: "Tạo phôi" }))) return;
    setBlankBusy(true);
    try {
      const r = await ctApi.makeBlank(product.id);
      props.onAssets([r.asset]);
      props.onProduct(r.product);
      props.flash("Đã tạo phôi trơn — kiểm tra vị trí thiết kế trên phôi ở nút “Phôi trơn”");
    } catch (e) {
      props.flash(e instanceof Error ? e.message : "Không tạo được phôi");
    } finally {
      setBlankBusy(false);
    }
  };

  const remove = async (a: CtAsset) => {
    if (!(await ctConfirm({ title: `Xoá mockup “${a.name}”?`, tone: "danger", confirmLabel: "Xoá" }))) return;
    await props.onDelete(a);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-5 p-6">
        <section className="grid gap-4 rounded-xl border bg-card p-4 md:grid-cols-[220px_220px_1fr]">
          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Phôi trơn</div>
            <div className="flex aspect-square items-center justify-center overflow-hidden rounded-lg border" style={CHECKER_STYLE}>
              {config.scene.url ? (
                // eslint-disable-next-line @next/next/no-img-element -- our R2 picture
                <img src={config.scene.url} alt="Phôi trơn" className="h-full w-full object-contain" />
              ) : (
                <span className="p-3 text-center text-[11px] text-muted-foreground">Chưa có phôi — mockup sẽ đặt artwork trên nền trắng</span>
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <CtButton size="sm" variant="outline" disabled={blankBusy} onClick={() => void makeBlank()} title="AI vẽ phôi trơn đúng hình khuôn in (lỗ treo, tỉ lệ), chụp thẳng — dùng cho Xem trước & Mockups">
                {blankBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} {blankBusy ? "Đang vẽ (~1 phút)…" : config.scene.url ? "Phôi AI mới" : "Tạo phôi bằng AI"}
              </CtButton>
              <CtButton size="sm" variant="ghost" onClick={props.onOpenScene} title="Upload phôi của bạn / chỉnh chỗ đặt thiết kế trên phôi">
                <Wallpaper className="h-3.5 w-3.5" /> Upload / chỉnh
              </CtButton>
            </div>
          </div>
          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Phôi + thiết kế</div>
            <div className="flex aspect-square items-center justify-center overflow-hidden rounded-lg border" style={CHECKER_STYLE}>
              {!art ? (
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              ) : config.scene.url && config.scene.width > 0 && config.scene.height > 0 && config.scene.box.w > 0 ? (
                // The phôi with the artwork in its box (photo px → % of the photo): the same place the front mockup uses.
                <div className="relative max-h-full max-w-full overflow-hidden" style={{ aspectRatio: `${config.scene.width} / ${config.scene.height}`, width: config.scene.width >= config.scene.height ? "100%" : "auto", height: config.scene.width >= config.scene.height ? "auto" : "100%" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- our R2 picture */}
                  <img src={config.scene.url} alt="Phôi" className="absolute inset-0 h-full w-full" />
                  {/* eslint-disable-next-line @next/next/no-img-element -- a local blob */}
                  <img
                    src={art}
                    alt="Thiết kế trên phôi"
                    className="absolute"
                    style={{
                      left: `${(config.scene.box.x / config.scene.width) * 100}%`,
                      top: `${(config.scene.box.y / config.scene.height) * 100}%`,
                      width: `${(config.scene.box.w / config.scene.width) * 100}%`,
                      height: `${(config.scene.box.h / config.scene.height) * 100}%`,
                    }}
                  />
                </div>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element -- a local blob
                <img src={art} alt="Thiết kế" className="h-full w-full object-contain" />
              )}
            </div>
            <p className="mt-2 text-[11px] leading-snug text-muted-foreground">Nội dung đang chọn ở Thiết kế — mockup tạo từ đúng sản phẩm này. Đổi lựa chọn ở Thiết kế để xem bản khác.</p>
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <div>
              <h3 className="text-sm font-semibold">Mockup bằng AI</h3>
              <p className="text-xs text-muted-foreground">
                Artwork hoàn chỉnh (nội dung đang chọn ở Thiết kế) được đặt đúng lên phôi → 1 ảnh chụp thẳng chính xác. Từ ảnh đó AI tạo ảnh sản phẩm trong từng bối cảnh dưới đây (mỗi dòng 1 ảnh), giữ nguyên hình in.
              </p>
            </div>
            <CtTextarea rows={4} value={scenes} onChange={(e) => setScenes(e.target.value)} placeholder={"hanging on a Christmas tree with warm lights\nheld in a hand by the fireplace"} />
            <div className="flex items-center gap-2">
              <CtButton variant="primary" disabled={making} onClick={() => void make()}>
                {making ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} {making ? "Đang đặt lên phôi…" : "Tạo mockup"}
              </CtButton>
              {running.length > 0 && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> AI đang tạo {running.length} ảnh…
                </span>
              )}
              <button className="ml-auto rounded p-1 text-muted-foreground hover:bg-accent" onClick={() => void loadJobs()} title="Tải lại">
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </section>

        {(running.length > 0 || jobs.some((j) => j.status === "failed")) && (
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {jobs
              .filter((j) => j.status !== "done")
              .map((j) => (
                <figure key={j.id} className="overflow-hidden rounded-lg border bg-card">
                  <div className={cx("flex aspect-[4/5] items-center justify-center p-2 text-center text-[11px]", j.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
                    {j.status === "running" ? <Loader2 className="h-5 w-5 animate-spin" /> : j.error || "Lỗi"}
                  </div>
                  <figcaption className="truncate border-t p-1.5 text-[11px] text-muted-foreground" title={j.description}>
                    {j.description}
                  </figcaption>
                </figure>
              ))}
          </section>
        )}

        <section>
          <div className="mb-2 text-sm font-semibold">Ảnh sản phẩm ({mockups.length})</div>
          {mockups.length === 0 ? (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">Chưa có — bấm “Tạo mockup”.</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {mockups.map((m) => (
                <figure key={m.id} className="group relative overflow-hidden rounded-lg border bg-white">
                  <a href={m.url} target="_blank" rel="noreferrer">
                    {/* eslint-disable-next-line @next/next/no-img-element -- our R2 picture */}
                    <img src={m.url} alt={m.name} className="aspect-square w-full object-contain" loading="lazy" />
                  </a>
                  <button className="absolute right-1 top-1 hidden rounded bg-black/60 p-1 text-white group-hover:block" onClick={() => void remove(m)} aria-label="Xoá mockup">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                  <figcaption className="truncate p-1.5 text-[11px] text-muted-foreground">{m.name}</figcaption>
                </figure>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
