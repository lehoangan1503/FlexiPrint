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
 *   Bản custom  (asked 2026-11-17) "Mỗi ảnh 1 bản custom khác nhau": each prompt gets its own random pick of what the
 *               customer can change (lib/mockup-variants.ts) — version, options, a different name, a different sample
 *               person in each photo zone (server/mockup-samples.ts) — rendered here, one print per prompt.
 *   Refused     (asked 2026-11-12) a photo the image model refused on safety grounds: "Gửi @flexiprint sửa prompt" — the
 *               agent rewrites the prompt and draws the same job again (agent task kind mockup, server/mcp/mockup-tools.ts).
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps } from "react";
import { Bot, ChevronDown, ChevronRight, Loader2, Plus, RefreshCw, Sparkles, Trash2, Upload, Wallpaper } from "lucide-react";
import type { CtAgentTask, CtAsset, CtBaseMockup, CtMockupBlock, CtPackImage, CtPhotoStyleRef, CtProduct, CtProductConfig, CtRegion, CtRegionItem, CtSelection } from "../../types";
import { ctApi } from "../../lib/api-client";
import { canvasToBlob, renderComposite } from "../../lib/compositor";
import { defaultCategoryRules, displayAssets } from "../../lib/library";
import { ctConfirm } from "../dialogs";
import { splitScenes } from "../../lib/mockup-scenes";
import { CT_MOCKUP_BLOCK_REFS_MAX } from "../../lib/mockup-prompt";
import { MockupPics } from "../base/base-mockup-section";
import { SortableMockups } from "../sortable-mockups";
import { effectivePicks, orderMockups, pickedMockups, type CtMockupPicks } from "../../lib/deploy-media";
import { normalizeProductConfig } from "../../lib/design";
import { customizable, customizableText, isCustomizable, mockupVariants } from "../../lib/mockup-variants";
import { CHECKER_STYLE, CtButton, CtLightbox, CtTextarea, cx } from "../ui";
import { useDoneAlert } from "../use-done-alert";

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
  /** The product row saved without a design change (mockup order / ticks). */
  onProductRow?: (p: CtProduct) => void;
  onOpenScene: () => void;
  flash: (msg: string) => void;
  /** The product page's left column (2026-11-07): sections stacked, not side by side. */
  compact?: boolean;
  /** The product base's mockup prompts (its page) — the box starts from them when the product has none of its own. */
  baseMockup?: CtBaseMockup | null;
}

/** Longest side of the artwork drawn on the phôi + thiết kế picture. */
const ART_PREVIEW_SIDE = 700;

/** The image model refused the request on safety grounds (as server/product-mockups.ts isSafetyRefusal). */
const isSafetyRefusal = (error: string) => /safety system|safety_violations|moderation_blocked|content policy/i.test(error);

/**
 * A prompt box as tall as its text (asked 2026-11-24: a long prompt needed a drag to read), up to most of the screen;
 * a short prompt keeps a short box. Still resizable by hand.
 */
function PromptBox(props: ComponentProps<typeof CtTextarea>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, Math.round(window.innerHeight * 0.7))}px`;
  }, []);
  useLayoutEffect(fit, [fit, props.value]);
  // The text wraps again when the panel gets wider or narrower.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const seen = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    seen.observe(el);
    return () => seen.disconnect();
  }, [fit]);
  return <CtTextarea ref={ref} rows={2} {...props} />;
}

/** Same prompts, same pictures. */
const sameBlocks = (a: CtMockupBlock[], b: CtMockupBlock[]) => a.length === b.length && a.every((x, i) => x.prompt === b[i].prompt && x.refs.join("\n") === b[i].refs.join("\n"));

const isOpenTask = (t: CtAgentTask) => t.status === "pending" || t.status === "running" || t.status === "waiting";


export function AiMockupsPanel(props: AiMockupsPanelProps) {
  const { product, main, assets, regions, items, selection, config } = props;
  // One block = one prompt = one AI photo, with its own reference pictures (asked 2026-11-23). The product's own blocks
  // (kept on it), else its base's scenes, else nothing (asked 2026-11-18: no hidden prompt).
  const baseScenes = props.baseMockup?.scenes.trim() ?? "";
  const baseList = useMemo<CtMockupBlock[]>(() => (baseScenes ? splitScenes(baseScenes).scenes.map((prompt) => ({ prompt, refs: [] })) : []), [baseScenes]);
  // null = not edited yet: the blocks follow what they start from (the bases load after the panel).
  const [typed, setTyped] = useState<CtMockupBlock[] | null>(null);
  // What the server keeps (the design's config is not reloaded after a mockup call).
  const [saved, setSaved] = useState<CtMockupBlock[]>(config.mockupBlocks);
  const blocks = typed ?? (saved.length ? saved : baseList);
  const ready = useMemo(() => blocks.filter((b) => b.prompt.trim()).map((b) => ({ prompt: b.prompt.trim(), refs: b.refs })), [blocks]);
  const own = ready.length > 0 && !sameBlocks(ready, baseList);
  const hasBase = !!product.base_product_id;
  // Picture 1 is the product itself; a block without pictures of its own is sent with the base's.
  const baseRefs = props.baseMockup?.refs ?? [];
  const [frontZoom, setFrontZoom] = useState<number | null>(null);
  const [savingBlocks, setSavingBlocks] = useState(false);
  // Blocks start folded (asked 2026-11-24: keep the box short); a click on the header opens one.
  const [openBlocks, setOpenBlocks] = useState<Set<number>>(() => new Set());
  const toggleBlock = (i: number) =>
    setOpenBlocks((cur) => {
      const next = new Set(cur);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const editBlock = (i: number, b: CtMockupBlock | null) => {
    const next = [...blocks];
    if (b) next[i] = b;
    else next.splice(i, 1);
    setTyped(next);
    return next;
  };
  const saveBlocks = async (list: CtMockupBlock[], quiet = false) => {
    setSavingBlocks(true);
    try {
      const keep = list.filter((b) => b.prompt.trim()).map((b) => ({ prompt: b.prompt.trim(), refs: b.refs }));
      const r = await ctApi.setMockupBlocks(product.id, keep);
      setSaved(normalizeProductConfig(r.product.config).mockupBlocks);
      props.onProductRow?.(r.product);
      if (!quiet) props.flash("Đã lưu prompt mockup của sản phẩm");
    } catch (e) {
      props.flash(e instanceof Error ? e.message : "Không lưu được prompt");
    } finally {
      setSavingBlocks(false);
    }
  };
  const [backBusy, setBackBusy] = useState(false);
  const backToBase = async () => {
    setBackBusy(true);
    try {
      const r = await ctApi.clearMockupScenes(product.id);
      setTyped(null);
      setSaved([]);
      props.onProduct(r.product);
      props.flash(baseScenes ? "Sản phẩm dùng lại prompt của product base" : "Đã bỏ cảnh riêng — product base chưa có cảnh nào, Tạo mockup sẽ báo lỗi");
    } catch (e) {
      props.flash(e instanceof Error ? e.message : "Không lưu được");
    } finally {
      setBackBusy(false);
    }
  };
  const [jobs, setJobs] = useState<CtPackImage[]>([]);
  const [making, setMaking] = useState<"" | "samples" | "print">("");
  // Each mockup a different custom pick (on by default when there is something to customise).
  const custom = useMemo(() => customizable(regions, items, assets, config.main, main.id), [regions, items, assets, config.main, main.id]);
  const canVary = isCustomizable(custom);
  const [vary, setVary] = useState(config.mockupVary);
  const varying = vary && canVary;
  /** The last "Tạo mockup"'s designs, one per prompt (local blobs), to see what each photo is made of. */
  const [picks, setPicks] = useState<Array<{ url: string; label: string; scene: string }>>([]);
  useEffect(() => () => picks.forEach((p) => URL.revokeObjectURL(p.url)), [picks]);
  const [blankBusy, setBlankBusy] = useState(false);
  const allMockups = useMemo(() => assets.filter((a) => a.role === "mockup" && a.product_id === product.id).sort((a, b) => a.created_at.localeCompare(b.created_at)), [assets, product.id]);
  // The order + ticks they go to Shopify with (asked 2026-11-19) — the Deploy page and every deploy read the same.
  const [mockPicks, setMockPicks] = useState<CtMockupPicks | null>(null);
  const shownPicks = useMemo(() => mockPicks ?? effectivePicks(allMockups, normalizeProductConfig(product.config), product.shopify?.media), [mockPicks, allMockups, product.config, product.shopify]);
  const mockups = useMemo(() => orderMockups(allMockups, shownPicks.mockupOrder), [allMockups, shownPicks.mockupOrder]);
  const mockOff = useMemo(() => {
    const on = new Set(pickedMockups(mockups, shownPicks));
    return mockups.filter((m) => !on.has(m.id)).map((m) => m.id);
  }, [mockups, shownPicks]);
  const savePicks = async (mockupOrder: string[], mockupOff: string[]) => {
    const prev = shownPicks;
    setMockPicks({ mockupOrder, mockupOff });
    try {
      const p = await ctApi.updateProduct(product.id, { mockupOrder, mockupOff });
      // Only the product row: the design (and its unsaved changes) is not touched.
      props.onProductRow?.(p);
    } catch (e) {
      setMockPicks(prev);
      props.flash(e instanceof Error ? e.message : "Không lưu được thứ tự ảnh");
    }
  };
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

  // @flexiprint's prompt fixes of refused photos: the latest task of each job.
  const [fixes, setFixes] = useState<CtAgentTask[]>([]);
  const [sending, setSending] = useState<string | null>(null);
  const fixOf = useMemo(() => {
    const m = new Map<string, CtAgentTask>();
    for (const t of fixes) {
      const id = t.input.mockup?.jobId;
      if (id && !m.has(id)) m.set(id, t);
    }
    return m;
  }, [fixes]);
  const fixing = fixes.filter(isOpenTask);
  const loadFixes = useCallback(async () => {
    try {
      setFixes(await ctApi.listAgentTasks("mockup", product.id));
    } catch {
      // Only a progress view.
    }
  }, [product.id]);

  useEffect(() => {
    const t = setTimeout(() => {
      void loadJobs();
      void loadFixes();
    }, 0);
    return () => clearTimeout(t);
  }, [loadJobs, loadFixes]);

  // While the agent works on a refused photo: its progress, and the job it draws again.
  useEffect(() => {
    if (!fixing.length) return;
    const t = setInterval(async () => {
      const before = new Set(fixing.map((f) => f.id));
      await Promise.all([loadJobs(), loadFixes()]);
      try {
        const done = (await ctApi.listAgentTasks("mockup", product.id)).filter((f) => before.has(f.id) && !isOpenTask(f));
        for (const f of done) props.flash(f.status === "done" && f.result ? `@flexiprint: ${f.result.summary}` : `@flexiprint không sửa được: ${f.error || f.status}`);
      } catch {
        // Next round.
      }
    }, 4000);
    return () => clearInterval(t);
    // props.flash is a fresh closure each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixing.length, loadJobs, loadFixes, product.id]);

  const sendFix = async (job: CtPackImage) => {
    setSending(job.id);
    try {
      const t = await ctApi.createAgentTask({
        kind: "mockup",
        input: { category: { id: null, name: "", spec: "", rules: defaultCategoryRules() }, note: "", images: [], refUrls: [], mockup: { productId: product.id, productName: product.name, jobId: job.id, scene: job.description, prompt: "", error: "", refUrl: "", request: "" } },
      });
      setFixes((cur) => [t, ...cur.filter((x) => x.id !== t.id)]);
      props.flash("Đã gửi @flexiprint — agent xem prompt, bỏ chữ nhạy cảm rồi tạo lại ảnh này");
    } catch (e) {
      props.flash(e instanceof Error ? e.message : "Không gửi được cho @flexiprint");
    } finally {
      setSending(null);
    }
  };

  useDoneAlert(running.length > 0);
  useDoneAlert(fixing.length > 0);
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
    if (!ready.length) {
      props.flash("Không có prompt cảnh nào — viết vào một khối prompt ở trên hoặc ô «Cảnh» ở trang product base.");
      return;
    }
    setMaking("print");
    try {
      // The finished artwork: the print file (whole edit frame cut to the khuôn) — the phôi is blank, everything
      // printed goes on it.
      const printOf = async (sel: CtSelection) =>
        canvasToBlob(await renderComposite({ main, assets: displayAssets(assets, "flat"), regions, items, selection: sel, scale: 1, layouts: config.layouts, cutToFrame: true }), "image/png");
      const lines = ready.map((b) => b.prompt);
      const keep = own ? ready : [];
      if (!varying) {
        const r = await ctApi.makeMockups(product.id, await printOf(selection), ready, true, canVary ? false : undefined);
        setSaved(keep);
        setJobs((cur) => [...r.jobs, ...cur.filter((j) => !r.jobs.some((x) => x.id === j.id))]);
        props.flash(`AI đang tạo ${lines.length} ảnh bối cảnh từ artwork trên phôi (1–2 phút / ảnh)`);
        return;
      }
      // One random custom pick per prompt; its photo zones filled with a different sample person / pet by the server.
      const variants = mockupVariants({ regions, items, assets, base: selection, main: config.main, defaultMainId: main.id, count: Math.max(1, lines.length) });
      const byZone = new Map<string, Array<{ variant: number; style: CtPhotoStyleRef; name: string }>>();
      variants.forEach((v, i) => v.photos.forEach((p) => byZone.set(p.regionId, [...(byZone.get(p.regionId) ?? []), { variant: i, style: p.style, name: p.name }])));
      const problems: string[] = [];
      if (byZone.size) {
        setMaking("samples");
        await Promise.all(
          [...byZone].map(async ([regionId, list]) => {
            try {
              const samples = await ctApi.mockupSamples(product.id, regionId, list.map(({ style, name }) => ({ style, name })));
              samples.forEach((smp, k) => {
                const v = variants[list[k].variant];
                const sel = v.selection[regionId];
                if (smp.url && sel?.kind === "photo") v.selection[regionId] = { ...sel, url: smp.url };
                else if (smp.error) problems.push(smp.error);
              });
            } catch (e) {
              problems.push(e instanceof Error ? e.message : "Không tạo được ảnh khách mẫu");
            }
          }),
        );
        setMaking("print");
      }
      const prints: Blob[] = [];
      for (const v of variants) prints.push(await printOf(v.selection));
      setPicks(prints.map((b, i) => ({ url: URL.createObjectURL(b), label: variants[i].label, scene: lines[i] ?? "" })));
      const r = await ctApi.makeMockups(product.id, prints, ready, true, true);
      setSaved(keep);
      setJobs((cur) => [...r.jobs, ...cur.filter((j) => !r.jobs.some((x) => x.id === j.id))]);
      const missed = [...new Set(problems)];
      props.flash(`AI đang tạo ${prints.length} ảnh, mỗi ảnh 1 bản custom khác nhau (1–2 phút / ảnh)${missed.length ? ` — ảnh khách mẫu lỗi: ${missed.join("; ")}` : ""}`);
    } catch (e) {
      props.flash(e instanceof Error ? e.message : "Không tạo được mockup");
    } finally {
      setMaking("");
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

  // Mockups made elsewhere (a photographer, Photoshop): uploaded as they are (asked 2026-11-07, "nút import mockup thủ công").
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(0);
  const importFiles = async (files: File[]) => {
    setUploading(files.length);
    const added: CtAsset[] = [];
    for (const f of files) {
      try {
        added.push(await ctApi.uploadAsset(product.id, f, { role: "mockup", name: f.name.replace(/\.[a-z0-9]+$/i, "") }));
      } catch (e) {
        props.flash(e instanceof Error ? e.message : "Không upload được");
      }
      setUploading((n) => n - 1);
    }
    if (added.length) {
      props.onAssets(added);
      props.flash(`Đã thêm ${added.length} mockup`);
    }
  };

  const remove = async (a: CtAsset) => {
    if (!(await ctConfirm({ title: `Xoá mockup “${a.name}”?`, tone: "danger", confirmLabel: "Xoá" }))) return;
    await props.onDelete(a);
  };
  // Bulk delete (asked 2026-11-20), always shown: the unticked mockups (not going to Shopify) when some are unticked,
  // otherwise every mockup of the product ("có trường hợp xoá hết").
  const [bulkDeleting, setBulkDeleting] = useState(0);
  const bulkAll = mockOff.length === 0;
  const removeUnticked = async () => {
    const gone = bulkAll ? mockups : mockups.filter((m) => mockOff.includes(m.id));
    if (!gone.length) return;
    const ask = bulkAll
      ? { title: `Xoá hết ${gone.length} mockup của sản phẩm?`, message: "Không có ảnh nào đang bỏ chọn nên xoá TẤT CẢ ảnh sản phẩm, không lấy lại được. Muốn giữ ảnh nào thì bỏ chọn các ảnh cần xoá trước." }
      : { title: `Xoá ${gone.length} mockup không đưa lên Shopify?`, message: "Các ảnh đang bỏ chọn (không có số) bị xoá hẳn, không lấy lại được. Ảnh đang có số giữ nguyên." };
    if (!(await ctConfirm({ ...ask, tone: "danger", confirmLabel: `Xoá ${gone.length} ảnh` }))) return;
    setBulkDeleting(gone.length);
    try {
      for (const m of gone) {
        await props.onDelete(m);
        setBulkDeleting((n) => n - 1);
      }
    } finally {
      setBulkDeleting(0);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className={cx("mx-auto max-w-6xl space-y-5", props.compact ? "p-4" : "p-6")}>
        <section className={cx("grid gap-4 rounded-xl border bg-card p-4", props.compact ? "grid-cols-2" : "md:grid-cols-[220px_220px_1fr]")}>
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
            {product.base_product_id ? (
              // The base owns the phôi + box (2026-11-08); a phôi made here was overwritten by the next base save — so the
              // product only sets the mockups' style below (asked 2026-11-17).
              <p className="mt-2 text-[11px] text-muted-foreground">
                Phôi trơn + khung lấy từ product base — đổi ở{" "}
                <a href={`/base-products/${product.base_product_id}`} target="_blank" rel="noreferrer" className="text-sky-600 hover:underline">
                  trang product base
                </a>{" "}
                (mọi sản phẩm cùng đổi). Ở đây chỉ đổi phong cách mockup.
              </p>
            ) : (
            <div className="mt-2 flex flex-wrap gap-1.5">
              <CtButton size="sm" variant="outline" disabled={blankBusy} onClick={() => void makeBlank()} title="AI vẽ phôi trơn đúng hình khuôn in (lỗ treo, tỉ lệ), chụp thẳng — dùng cho Xem trước & Mockups">
                {blankBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} {blankBusy ? "Đang vẽ (~1 phút)…" : config.scene.url ? "Phôi AI mới" : "Tạo phôi bằng AI"}
              </CtButton>
              <CtButton size="sm" variant="ghost" onClick={props.onOpenScene} title="Upload phôi của bạn / chỉnh chỗ đặt thiết kế trên phôi">
                <Wallpaper className="h-3.5 w-3.5" /> Upload / chỉnh
              </CtButton>
            </div>
            )}
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
                  {config.scene.overlay && (
                    // eslint-disable-next-line @next/next/no-img-element -- our R2 picture
                    <img src={config.scene.overlay} alt="" className="absolute inset-0 h-full w-full" />
                  )}
                </div>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element -- a local blob
                <img src={art} alt="Thiết kế" className="h-full w-full object-contain" />
              )}
            </div>
            <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
              {varying
                ? "Nội dung mẫu của artwork — mỗi mockup sẽ là 1 bản custom ngẫu nhiên khác."
                : props.compact
                  ? "Nội dung mẫu của artwork — tham khảo khi tạo mockup."
                  : "Nội dung đang chọn ở Thiết kế — mockup tạo từ đúng sản phẩm này. Đổi lựa chọn ở Thiết kế để xem bản khác."}
            </p>
          </div>
          <div className={cx("flex min-w-0 flex-col gap-2", props.compact && "col-span-2")}>
            <div>
              <h3 className="text-sm font-semibold">Mockup bằng AI</h3>
              <p className="text-xs text-muted-foreground">
                Artwork hoàn chỉnh (nội dung đang chọn ở Thiết kế) được đặt đúng lên phôi → 1 ảnh chụp thẳng chính xác. Từ ảnh đó AI tạo ảnh sản phẩm trong từng bối cảnh dưới đây, giữ nguyên hình in và chất liệu (hệ thống tự thêm). Mỗi khối prompt 1 ảnh, bấm «Thêm prompt» để thêm khối; mỗi khối có ảnh tham chiếu riêng, chỉ gửi kèm prompt của khối đó. Không giới hạn số prompt hay độ dài — mỗi ảnh là một lượt AI tính tiền.
              </p>
            </div>
            <div className={cx("flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 text-xs", own ? "border-amber-500/50 bg-amber-500/10" : "border-sky-500/40 bg-sky-500/10")}>
              <span className="font-medium text-foreground">
                {own
                  ? "Prompt riêng của sản phẩm này — sửa prompt ở trang product base sẽ không đổi sản phẩm này."
                  : hasBase && baseScenes
                    ? "Đang dùng prompt của product base — sửa ở đây và bấm Tạo mockup thì thành prompt riêng của sản phẩm này."
                    : "Product base chưa có cảnh nào — viết cảnh vào ô dưới (thành prompt riêng của sản phẩm này), ô trống thì Tạo mockup báo lỗi."}
              </span>
              {hasBase && (
                <a href={`/base-products/${product.base_product_id}`} target="_blank" rel="noreferrer" className="text-sky-700 underline dark:text-sky-300">
                  Mở prompt của base
                </a>
              )}
              {own && (
                <button className="ml-auto rounded border bg-background px-2 py-0.5 font-medium text-foreground hover:bg-accent disabled:opacity-50" disabled={backBusy} onClick={() => void backToBase()}>
                  {backBusy ? "Đang lưu…" : baseScenes ? "Dùng prompt của base" : "Bỏ cảnh riêng"}
                </button>
              )}
            </div>
            <div className="space-y-2">
              {blocks.length > 1 && (
                <div className="flex gap-3 text-xs">
                  <button type="button" className="text-foreground underline-offset-2 hover:underline" onClick={() => setOpenBlocks(new Set(blocks.map((_, i) => i)))}>
                    Mở hết
                  </button>
                  <button type="button" className="text-foreground underline-offset-2 hover:underline" onClick={() => setOpenBlocks(new Set())}>
                    Thu gọn hết
                  </button>
                </div>
              )}
              {blocks.map((b, i) => {
                const open = openBlocks.has(i);
                return (
                <div
                  key={i}
                  className={cx(
                    "space-y-1.5 rounded-lg border border-l-4 p-2 text-xs",
                    // Neighbouring blocks in two tints (asked 2026-11-24: they ran into one another).
                    i % 2 ? "border-l-amber-500 bg-amber-500/10" : "border-l-sky-500 bg-sky-500/10",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      aria-expanded={open}
                      title={open ? "Thu gọn" : "Bấm để mở"}
                      className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left hover:bg-accent"
                      onClick={() => toggleBlock(i)}
                    >
                      {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                      <span className="shrink-0 font-semibold text-foreground">Prompt {i + 1}</span>
                      <span className="shrink-0 text-foreground/70">· {b.refs.length ? `${b.refs.length} ảnh tham chiếu` : "không ảnh riêng"}</span>
                      {!open && <span className="min-w-0 truncate text-foreground/80">— {b.prompt.trim() || "(trống)"}</span>}
                    </button>
                    <button
                      type="button"
                      title="Xoá prompt này"
                      className="shrink-0 rounded p-1 text-foreground/70 hover:bg-accent hover:text-foreground"
                      onClick={() => {
                        setOpenBlocks(new Set());
                        void saveBlocks(editBlock(i, null), true);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {open && (
                  <>
                  <PromptBox
                    className="bg-background"
                    value={b.prompt}
                    onChange={(e) => editBlock(i, { ...b, prompt: e.target.value })}
                    onBlur={() => typed && void saveBlocks(typed, true)}
                    placeholder="hanging on a Christmas tree with warm lights, same room as picture 2"
                  />
                  <div className="text-foreground">
                    Ảnh tham chiếu riêng của prompt này ({b.refs.length}/{CT_MOCKUP_BLOCK_REFS_MAX}) —{" "}
                    {b.refs.length ? "chỉ gửi kèm prompt này, là ảnh 2, 3… sau ảnh sản phẩm" : baseRefs.length ? `chưa có, sẽ gửi ${baseRefs.length} ảnh tham chiếu của product base` : "chưa có, chỉ gửi ảnh sản phẩm"}
                  </div>
                  <MockupPics urls={b.refs} max={CT_MOCKUP_BLOCK_REFS_MAX} first={2} onChange={(refs) => void saveBlocks(editBlock(i, { ...b, refs }), true)} />
                  </>
                  )}
                </div>
                );
              })}
              <div className="flex flex-wrap items-center gap-2">
                <CtButton size="sm" onClick={() => {
                  setOpenBlocks((cur) => new Set(cur).add(blocks.length));
                  setTyped([...blocks, { prompt: "", refs: [] }]);
                }}>
                  <Plus className="h-4 w-4" /> Thêm prompt
                </CtButton>
                {savingBlocks && <span className="flex items-center gap-1 text-xs text-foreground/70"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Đang lưu…</span>}
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-lg border p-2 text-xs">
              <div className="shrink-0">
                <button type="button" disabled={!art} onClick={() => setFrontZoom(0)} className="flex h-20 w-20 cursor-zoom-in items-center justify-center overflow-hidden rounded-md border bg-white" title="Bấm để phóng to">
                  {art ? (
                    // eslint-disable-next-line @next/next/no-img-element -- a local blob
                    <img src={art} alt="Ảnh sản phẩm" className="h-full w-full object-contain" />
                  ) : (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  )}
                </button>
                <div className="mt-1 text-center text-[11px] font-medium text-foreground">Ảnh 1 · sản phẩm</div>
              </div>
              <p className="text-foreground/80">
                Ảnh 1 (thiết kế đặt lên phôi) luôn gửi kèm mọi prompt. Ảnh tham chiếu của khối nào chỉ đi theo prompt của khối đó; trong prompt gọi bằng số: “same room as picture 2”. Khối không có ảnh riêng thì dùng ảnh tham chiếu của product base.
              </p>
              <CtLightbox images={art ? [{ url: art, name: "Ảnh 1 · sản phẩm" }] : []} index={frontZoom} onIndex={setFrontZoom} />
            </div>
            <p className="text-xs text-muted-foreground">{ready.length ? `Sẽ tạo ${ready.length} ảnh — mỗi khối prompt 1 ảnh.` : "Chưa có prompt nào — Tạo mockup sẽ báo lỗi."}</p>
            {canVary && (
              <label className="flex cursor-pointer items-start gap-2 rounded-lg border bg-muted/30 p-2 text-xs">
                <input type="checkbox" className="mt-0.5" checked={vary} onChange={(e) => setVary(e.target.checked)} />
                <span>
                  <span className="font-medium">Mỗi ảnh 1 bản custom khác nhau (ngẫu nhiên)</span>
                  <span className="block text-muted-foreground">
                    Sản phẩm cho khách đổi: {customizableText(custom)}. Mỗi prompt lấy ngẫu nhiên version / option / tên khác nhau{custom.photos ? ", ảnh khách là người (thú cưng) mẫu khác nhau chạy qua style của vùng (~1 phút)" : ""}. Tắt = mọi ảnh dùng nội dung đang chọn ở Thiết kế.
                  </span>
                </span>
              </label>
            )}
            <div className="flex items-center gap-2">
              <CtButton variant="primary" disabled={making !== ""} onClick={() => void make()}>
                {making ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} {making === "samples" ? "Đang tạo ảnh khách mẫu…" : making ? "Đang đặt lên phôi…" : "Tạo mockup"}
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

        {picks.length > 0 && (
          <section>
            <div className="mb-2 text-sm font-semibold">Bản custom của từng ảnh (lần tạo vừa rồi)</div>
            <div className={cx("grid gap-3", props.compact ? "grid-cols-3" : "grid-cols-3 sm:grid-cols-4 lg:grid-cols-6")}>
              {picks.map((p, i) => (
                <figure key={p.url} className="overflow-hidden rounded-lg border bg-card">
                  <div className="flex aspect-square items-center justify-center" style={CHECKER_STYLE}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- a local blob */}
                    <img src={p.url} alt={p.label || `Bản ${i + 1}`} className="h-full w-full object-contain" />
                  </div>
                  <figcaption className="border-t p-1.5 text-[11px] leading-snug">
                    <div className="truncate font-medium" title={p.label}>{p.label || `Bản ${i + 1}`}</div>
                    <div className="truncate text-muted-foreground" title={p.scene}>{p.scene}</div>
                  </figcaption>
                </figure>
              ))}
            </div>
          </section>
        )}

        {(running.length > 0 || jobs.some((j) => j.status === "failed")) && (
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {jobs
              .filter((j) => j.status !== "done")
              .map((j) => (
                <figure key={j.id} className="overflow-hidden rounded-lg border bg-card">
                  {j.status === "running" ? (
                    <div className="flex aspect-[4/5] flex-col items-center justify-center gap-1.5 p-2 text-center text-[11px] text-muted-foreground">
                      <Loader2 className="h-5 w-5 animate-spin" />
                      {fixOf.get(j.id) && isOpenTask(fixOf.get(j.id)!) && <span>Đang tạo lại với prompt @flexiprint sửa…</span>}
                    </div>
                  ) : (
                    <FailedJob job={j} fix={fixOf.get(j.id) ?? null} sending={sending === j.id} onFix={() => void sendFix(j)} />
                  )}
                  <figcaption className="truncate border-t p-1.5 text-[11px] text-muted-foreground" title={j.description}>
                    {j.description}
                  </figcaption>
                </figure>
              ))}
          </section>
        )}

        <section>
          <div className="mb-2 flex items-center gap-2">
            <span className="text-sm font-semibold" title="Kéo ô tay cầm để đổi thứ tự, bấm số / ô vuông để chọn hoặc bỏ. Đây là thứ tự và các ảnh trang Deploy đưa lên Shopify — ảnh 1 là ảnh chính.">
              Ảnh sản phẩm ({mockups.length - mockOff.length}/{mockups.length} đưa lên Shopify)
            </span>
            <CtButton size="sm" variant="outline" className="ml-auto text-red-600 hover:text-red-700" disabled={bulkDeleting > 0 || mockups.length === 0} onClick={() => void removeUnticked()} title={bulkAll ? "Xoá hẳn tất cả mockup (bỏ chọn vài ảnh thì chỉ xoá các ảnh đó)" : "Xoá hẳn các mockup đang bỏ chọn (không đưa lên Shopify)"}>
              {bulkDeleting > 0 ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} {bulkDeleting > 0 ? `Đang xoá ${bulkDeleting}…` : bulkAll ? `Xoá hết ${mockups.length} ảnh` : `Xoá ${mockOff.length} ảnh bỏ chọn`}
            </CtButton>
            <CtButton size="sm" variant="outline" disabled={uploading > 0} onClick={() => fileRef.current?.click()} title="Thêm mockup có sẵn (ảnh chụp, Photoshop…)">
              {uploading > 0 ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} {uploading > 0 ? `Đang upload ${uploading}…` : "Import mockup"}
            </CtButton>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                if (files.length) void importFiles(files);
              }}
            />
          </div>
          {mockups.length === 0 ? (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">Chưa có — bấm “Tạo mockup” hoặc “Import mockup”.</p>
          ) : (
            <SortableMockups
              fit="contain"
              images={mockups.map((m) => ({ id: m.id, url: m.url, name: m.name }))}
              off={mockOff}
              onChange={(order, off) => void savePicks(order, off)}
              className={cx("grid gap-3", props.compact ? "grid-cols-3" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5")}
              caption={(img) => img.name}
              overlay={(img) => (
                <button className="absolute right-1 top-1 rounded bg-black/60 p-1 text-white hover:bg-black" onClick={() => void remove(mockups.find((m) => m.id === img.id)!)} aria-label="Xoá mockup" title="Xoá mockup">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            />
          )}
        </section>
      </div>
    </div>
  );
}

/** A failed mockup photo: the model's answer, and — refused on safety grounds — the agent's prompt fix. */
function FailedJob({ job, fix, sending, onFix }: { job: CtPackImage; fix: CtAgentTask | null; sending: boolean; onFix: () => void }) {
  const refused = isSafetyRefusal(job.error);
  const working = fix !== null && isOpenTask(fix);
  const lastLine = fix?.progress?.length ? fix.progress[fix.progress.length - 1].text : "";
  return (
    <div className="flex aspect-[4/5] flex-col gap-1.5 p-2 text-[11px]">
      <div className="min-h-0 flex-1 overflow-y-auto text-center text-destructive" title={job.prompt}>
        {job.error || "Lỗi"}
      </div>
      {working ? (
        <div className="rounded border border-primary/30 bg-primary/5 p-1.5 text-muted-foreground">
          <div className="flex items-center gap-1 font-medium text-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> @flexiprint đang sửa prompt
          </div>
          {lastLine && <div className="mt-0.5 line-clamp-3">{lastLine}</div>}
        </div>
      ) : (
        <>
          {fix?.status === "failed" && <div className="line-clamp-3 text-muted-foreground">@flexiprint: {fix.error}</div>}
          {fix?.status === "done" && fix.result && <div className="line-clamp-3 text-muted-foreground">@flexiprint: {fix.result.summary}</div>}
          {refused && (
            <CtButton size="sm" variant="outline" disabled={sending} onClick={onFix} title="@flexiprint xem prompt và ảnh tham chiếu, bỏ / thay chữ nhạy cảm, rồi tạo lại ảnh này ngay">
              {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bot className="h-3.5 w-3.5" />} {fix ? "Gửi lại @flexiprint" : "Gửi @flexiprint sửa prompt"}
            </CtButton>
          )}
        </>
      )}
    </div>
  );
}
