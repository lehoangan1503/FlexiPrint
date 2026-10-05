"use client";

/**
 * "Sửa nhanh": fix one picture of a set — its gốc, a vật liệu version or a đa sắc — straight away, no analysis.
 *
 *   Miễn phí  ComfyUI FP Adjust, no AI: recolour the body colour (pixel recolour — line work, shading and
 *             silhouette stay 100 %) of that ONE picture; its own vật liệu versions get the same recolour.
 *             Recipe "adjust".
 *   AI        what is typed goes to FP Refine as the change, with the category spec, the style pack and the
 *             material as the set's rules, plus reference images. Recipe "refine".
 *
 * Everything made FROM the fixed picture is made again from the new one, with the category's settings — the
 * same jobs as "Tạo bằng AI", only fed the new picture:
 *   - its đa sắc: remade the way each was made (its variant line, meta.variant: a colour is a free recolour,
 *     a style an AI edit) — recipe "variant";
 *   - its vật liệu versions: rendered again, same preset — recipe "material";
 *   - and, down the tree, the đa sắc of those vật liệu versions / the vật liệu of those đa sắc.
 * So fixing the gốc remakes the whole set; fixing one đa sắc / vật liệu only touches what hangs off it.
 *
 * Each new picture takes its old one's place (server replaceClipart, keep_renditions: products using it
 * switch, what hangs off it moves to the new one until it is remade, the old one is deleted).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ImagePlus, Loader2, Palette, Sparkles, Wand2, X } from "lucide-react";
import type { CtAsset, CtClipartCategory, CtPreset, CtStudioLine } from "../../types";
import { ctApi } from "../../lib/api-client";
import { clipartFamily, isMaterialClipart, isMulticolorClipart, normalizeCategoryRules, renditionsOf } from "../../lib/library";
import { CHECKER_STYLE, CtButton, CtField, CtInput, CtModal, CtSelect, CtTextarea, cx } from "../ui";
import { refImage } from "../library/library-manager";
import { CLIPART_DRAG, ClipartBadges, type CtClipartDrag } from "../editor/library-panel";
import { colourOnly, MAX_REFS, QUICK_PALETTE, REF_DRAG, REFINE_MODEL } from "./refine-shared";

export interface CtQuickFixTarget {
  /** The cliparts the dialog opens on (one, or an origin's set members); the whole set is shown once loaded. */
  assets: CtAsset[];
  /** Preselected (default: the first). */
  initial?: string[];
  /** Set members: their origin. */
  origin?: CtAsset | null;
}

export interface CtQuickFixDialogProps {
  target: CtQuickFixTarget | null;
  onClose: () => void;
  /** The run finished: what it saved, and old → new (each old one was replaced). */
  onDone: (fresh: CtAsset[], replaced: Array<{ old: CtAsset; next: CtAsset }>) => void;
}

interface Ref {
  preview: string;
  blob: Blob;
  name: string | null;
  clipart?: { id: string; name: string };
}

/** A member made again from the new origin. */
interface Remake {
  old: CtAsset;
  line: CtStudioLine;
  /** Recolour (no AI) rather than an AI edit. */
  free: boolean;
}

type Mode = "free" | "ai";

/** Bookkeeping of one run of the dialog. */
interface Outcome {
  fresh: CtAsset[];
  replaced: Array<{ old: CtAsset; next: CtAsset }>;
  failed: string[];
  notes: string[];
}

/** The material preset a vật liệu picture was rendered with (to render it again the same way). */
function materialOf(r: CtAsset): string | null {
  return typeof r.meta?.material === "string" && UUID.test(r.meta.material) ? r.meta.material : null;
}

/** The "Màu gốc" choice in the colour picker. */
const ORIGINAL = "original";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Key for mounting the dialog: a new target starts a fresh form. */
export function quickFixKey(t: CtQuickFixTarget | null): string {
  return t ? t.assets.map((a) => a.id).join(",") : "closed";
}

/**
 * How `m` is made again from its (fixed) origin: its own variant line — or, for one made before lines were
 * kept, its swatch / the colour its name says (a recolour), else its name as the AI change ("rainbow").
 */
function remakeOf(m: CtAsset): Remake {
  const v = m.meta?.variant;
  const line = (text: string, mode: "recolor" | "ai" | undefined): CtStudioLine => ({ name: m.name, text, ...(mode ? { mode } : {}), replaces: m.id });
  if (v?.text?.trim()) {
    const text = v.text.trim();
    return { old: m, free: v.mode === "recolor" || (v.mode !== "ai" && HEX.test(text)), line: line(text, v.mode) };
  }
  const colour = (m.meta?.swatch && HEX.test(m.meta.swatch) ? m.meta.swatch : null) ?? colourOnly(m.name);
  return colour ? { old: m, free: true, line: line(colour, "recolor") } : { old: m, free: false, line: line(m.name, "ai") };
}

export function QuickFixDialog({ target, onClose, onDone }: CtQuickFixDialogProps) {
  const open = target !== null;
  const given = useMemo(() => (target ? [...(target.origin ? [target.origin] : []), ...target.assets] : []), [target]);
  // Mounted with a `key` per target (quickFixKey): the form starts clean from the target.
  const [chosenId, setChosenId] = useState<string | null>(() => target?.initial?.[0] ?? target?.assets[0]?.id ?? null);
  const [mode, setMode] = useState<Mode>(() => (target?.assets[0]?.role === "variant" ? "free" : "ai"));
  const [colour, setColour] = useState("");
  const [fix, setFix] = useState("");
  const [refs, setRefs] = useState<Ref[]>([]);
  const [model, setModel] = useState(REFINE_MODEL);
  const [models, setModels] = useState<string[]>([]);
  const [categories, setCategories] = useState<CtClipartCategory[]>([]);
  const [presets, setPresets] = useState<CtPreset[]>([]);
  /** The category's cliparts, renditions included (null = loading; a clipart without a category has no set). */
  const [library, setLibrary] = useState<CtAsset[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    ctApi.listCategories().then((r) => setCategories(r.categories.map((c) => ({ ...c, rules: normalizeCategoryRules(c.rules) })))).catch(() => setCategories([]));
    ctApi.listPresets().then((r) => setPresets(r.presets)).catch(() => setPresets([]));
    ctApi
      .studioModels()
      .then((m) => {
        setModels(m);
        setModel((cur) => (m.includes(cur) ? cur : m.includes(REFINE_MODEL) ? REFINE_MODEL : (m[0] ?? "")));
      })
      .catch((e: Error) => setError(e.message));
  }, [open]);

  useEffect(
    () => () => {
      if (poll.current) clearTimeout(poll.current);
    },
    [],
  );

  const categoryId = given[0]?.category_id ?? null;
  useEffect(() => {
    if (!open || !categoryId) return;
    let live = true;
    ctApi
      .listCliparts(categoryId)
      .then((list) => live && setLibrary(list))
      .catch(() => live && setLibrary([]));
    return () => {
      live = false;
    };
  }, [open, categoryId]);

  const loaded = library !== null || !categoryId;
  const lib = useMemo(() => library ?? [], [library]);
  const category = categories.find((c) => c.id === categoryId) ?? null;
  const style = presets.find((p) => p.kind === "style_pack" && p.id === category?.rules.stylePackId) ?? null;

  // The set: its gốc and every picture of it (the chooser), and the picture being fixed.
  const find = (id: string | null | undefined) => (id ? (lib.find((a) => a.id === id) ?? given.find((a) => a.id === id) ?? null) : null);
  const lead = find(chosenId) ?? given[0] ?? null;
  const root = useMemo(() => {
    let cur = lead;
    for (let i = 0; cur?.parent_id && i < 4; i++) cur = find(cur.parent_id) ?? cur;
    return cur ?? target?.origin ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead, lib, given, target]);
  const family = useMemo(() => (root ? (library ? clipartFamily(library, root) : given) : lead ? [lead] : []), [root, library, given, lead]);
  const how: Mode = mode;
  const isRoot = lead !== null && lead.parent_id === null;

  /** Kids of a picture as listed now (snapshot: the remake walks the old tree). */
  const kidsOf = (id: string) => lib.filter((a) => a.parent_id === id);
  /** Everything made from `id`, all the way down. */
  const below = (id: string): CtAsset[] => kidsOf(id).flatMap((k) => [k, ...below(k.id)]);
  const derived = lead ? below(lead.id) : [];
  const remakes = derived.filter(isMulticolorClipart).map(remakeOf);
  const renders = derived.filter((a) => isMaterialClipart(a) && !isMulticolorClipart(a));
  const leadRenditions = lead ? renditionsOf(lib, lead.id) : [];

  // Reference picks: other sets' gốc only — a đa sắc's look comes from its gốc anyway.
  const candidates = lib.filter((a) => a.parent_id === null && a.id !== root?.id);
  const typedColour = how === "ai" ? colourOnly(fix) : null;
  const running = status !== null;
  const uploading = refs.some((r) => r.name === null);
  const hex = /^#[0-9a-f]{6}$/i.test(colour) ? colour : "";
  /**
   * "Màu gốc": the picture before its first recolour (kept), or — a đa sắc never recoloured here — its gốc's own
   * picture. null = it is already in its original colour.
   */
  const originalUrl = lead ? (lead.meta?.colorSource?.url ?? (isMulticolorClipart(lead) && lead.role !== "rendition" ? (find(lead.parent_id)?.url ?? null) : null)) : null;
  const restoring = colour === ORIGINAL;
  const ready = lead !== null && loaded && !running && !uploading && (how === "free" ? hex !== "" || (restoring && originalUrl !== null) : fix.trim() !== "" && model !== "");

  const addRef = async (blob: Blob, clipart?: Ref["clipart"]) => {
    const preview = URL.createObjectURL(blob);
    setRefs((cur) => (cur.length >= MAX_REFS ? cur : [...cur, { preview, blob, name: null, clipart }]));
    try {
      const name = await ctApi.studioUploadRef(new File([blob], "ref.jpg", { type: "image/jpeg" }));
      setRefs((cur) => cur.map((r) => (r.preview === preview ? { ...r, name } : r)));
    } catch (e) {
      setRefs((cur) => cur.filter((r) => r.preview !== preview));
      setError(e instanceof Error ? e.message : "Upload ảnh thất bại");
    }
  };
  const addFiles = async (files: File[]) => {
    for (const f of files.filter((x) => x.type.startsWith("image/")).slice(0, MAX_REFS - refs.length)) await addRef(await refImage(f));
  };
  const toggleClipart = async (a: CtAsset) => {
    const had = refs.find((r) => r.clipart?.id === a.id);
    if (had) return setRefs((cur) => cur.filter((r) => r !== had));
    if (refs.length >= MAX_REFS) return setError(`Tối đa ${MAX_REFS} ảnh mẫu`);
    const raw = await fetch(a.url).then((r) => r.blob());
    await addRef(await refImage(new File([raw], `${a.name}.png`, { type: raw.type || "image/png" })), { id: a.id, name: a.name });
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setOver(false);
    const card = e.dataTransfer.getData(REF_DRAG);
    const lib = e.dataTransfer.getData(CLIPART_DRAG);
    if (card || lib) {
      const a: CtAsset = card ? (JSON.parse(card) as CtAsset) : (JSON.parse(lib) as CtClipartDrag).asset;
      if (!refs.some((r) => r.clipart?.id === a.id)) void toggleClipart(a);
      return;
    }
    void addFiles(Array.from(e.dataTransfer.files));
  };

  /** Close / X / Esc only (never a click outside). A run keeps going; the library picks its result up. */
  const close = () => onClose();

  /** Poll a run to its end → the assets it saved. */
  const waitFor = (runId: string, label: (node: string | null | undefined) => string) =>
    new Promise<CtAsset[]>((resolve, reject) => {
      const tick = async () => {
        try {
          const st = await ctApi.studioRunStatus(runId);
          if (st.status === "done") return resolve(st.assets);
          if (st.status === "error") return reject(new Error(st.error ?? "Chạy thất bại"));
          setStatus(st.status === "queued" ? `Đang chờ${st.position ? ` (#${st.position})` : ""}…` : label(st.node));
        } catch {
          // A blip (dev server reload…): keep watching.
        }
        poll.current = setTimeout(() => void tick(), 2000);
      };
      poll.current = setTimeout(() => void tick(), 1500);
    });

  /** `next` takes `old`'s place; what hangs off `old` moves to it (to be made again from it). */
  const swap = async (old: CtAsset, next: CtAsset | undefined, out: Outcome): Promise<boolean> => {
    if (!next) {
      out.failed.push(old.name);
      return false;
    }
    try {
      await ctApi.replaceClipart(old.id, next.id, true);
      out.replaced.push({ old, next });
      return true;
    } catch {
      out.failed.push(old.name);
      return false;
    }
  };

  /** The new picture made from `old` among `made`: by meta.derivedFrom, else the only one. */
  const madeFrom = (old: CtAsset, made: CtAsset[], olds: number): CtAsset | undefined =>
    made.find((n) => n.meta?.derivedFrom === old.id) ?? (olds === 1 && made.length === 1 ? made[0] : undefined);

  const toTarget = (a: CtAsset) => ({ clipart_id: a.id, name: a.name, spec: a.spec, parent_id: a.parent_id && a.role !== "rendition" ? a.parent_id : null });

  /**
   * Make again, from `next` (the fixed `old`), everything that was made from `old`: its đa sắc the way each was
   * made, its vật liệu versions with their preset — then, the same way, what hangs off those.
   */
  const remakeBelow = async (old: CtAsset, next: CtAsset, out: Outcome): Promise<void> => {
    const kids = kidsOf(old.id);
    const members = kids.filter(isMulticolorClipart);
    const materials = kids.filter((k) => isMaterialClipart(k) && !isMulticolorClipart(k));
    const pairs: Array<{ old: CtAsset; next: CtAsset }> = [];

    if (members.length) {
      const lines = members.map(remakeOf);
      setStatus(`Tạo lại ${members.length} đa sắc của ${next.name}…`);
      const runId = await ctApi.studioRun({
        recipe: "variant",
        params: { clipart_id: next.id, variants: lines.map((x) => x.line), method: "auto", lock_silhouette: true, model },
      });
      const made = (await waitFor(runId, () => `Tạo lại ${members.length} đa sắc của ${next.name}…`)).filter((a) => a.parent_id === next.id);
      out.fresh.push(...made);
      for (const m of members) {
        const n = madeFrom(m, made, members.length);
        if (await swap(m, n, out)) pairs.push({ old: m, next: n as CtAsset });
      }
    }

    // One run per preset: a preset with "version" details makes all its versions of the picture at once.
    const byMaterial = new Map<string, CtAsset[]>();
    for (const r of materials) {
      const mid = materialOf(r);
      if (!mid) {
        out.notes.push(`${r.name}: không rõ preset vật liệu — tạo lại ở “Tạo bằng AI” bước 3`);
        continue;
      }
      byMaterial.set(mid, [...(byMaterial.get(mid) ?? []), r]);
    }
    for (const [mid, olds] of byMaterial) {
      setStatus(`Render lại vật liệu của ${next.name}…`);
      const base = olds.find((r) => !r.meta?.materialVersion) ?? olds[0];
      const runId = await ctApi.studioRun({
        recipe: "material",
        params: { material_id: mid, targets: [{ clipart_id: next.id, name: base.name }], lock: "preset", edge_px: 0, extra: "", model },
      });
      const made = (await waitFor(runId, () => `Render lại vật liệu của ${next.name}…`)).filter((a) => a.role === "rendition" && a.parent_id === next.id);
      out.fresh.push(...made);
      for (const r of olds) {
        const n = made.find((x) => (x.meta?.materialVersion ?? "") === (r.meta?.materialVersion ?? "")) ?? (olds.length === 1 ? made[0] : undefined);
        if (await swap(r, n, out)) pairs.push({ old: r, next: n as CtAsset });
      }
    }

    for (const p of pairs) await remakeBelow(p.old, p.next, out);
  };

  const runFree = async (one: CtAsset): Promise<Outcome> => {
    const out: Outcome = { fresh: [], replaced: [], failed: [], notes: [] };
    const renditions = leadRenditions.map((r) => ({ id: r.id, name: r.name, material: materialOf(r) }));
    setStatus("Đang gửi…");
    const runId = await ctApi.studioRun({ recipe: "adjust", params: { targets: [{ ...toTarget(one), renditions }], recolor: hex, flip: false } });
    const fresh = await waitFor(runId, (node) => (node === "FP_Adjust" ? "Đang đổi màu…" : node === "FP_SaveToLibrary" ? "Đang lưu…" : "Đang xử lý…"));
    out.fresh.push(...fresh);
    const next = fresh.find((f) => f.meta?.derivedFrom === one.id) ?? fresh.find((f) => f.role === one.role && f.parent_id === one.parent_id) ?? fresh[0];
    if (!next) throw new Error("Chạy xong nhưng không lưu ảnh nào");
    // Remember the picture before the FIRST recolour ("Màu gốc"); the server then keeps its file.
    const remember = (old: CtAsset, n: CtAsset) =>
      ctApi.updateClipart(n.id, { meta: { colorSource: old.meta?.colorSource ?? { url: old.url, ...(old.meta?.variant ? { variant: old.meta.variant } : {}) } } }).catch(() => null);
    await remember(one, next);
    if (!(await swap(one, next, out))) return out;
    // A đa sắc of a vật liệu version: from now on it is this colour of it (a fixed gốc remakes it so).
    if (one.role === "rendition" && isMulticolorClipart(one)) await ctApi.updateClipart(next.id, { meta: { variant: { text: hex, mode: "recolor" } } }).catch(() => null);
    // Its vật liệu versions came out recoloured too: each takes its old one's place (keeping the đa sắc made from it).
    const made = fresh.filter((f) => f.role === "rendition" && f.parent_id === next.id);
    for (const r of leadRenditions) {
      const n = made.find((x) => x.meta?.material === r.meta?.material && (x.meta?.materialVersion ?? "") === (r.meta?.materialVersion ?? ""));
      if (n) {
        await remember(r, n);
        await swap(r, n, out);
      }
    }
    return out;
  };

  /** "Màu gốc": the picture (and its vật liệu versions) back as before the first recolour — same ids, no AI. */
  const runRestore = async (one: CtAsset): Promise<Outcome> => {
    const out: Outcome = { fresh: [], replaced: [], failed: [], notes: [] };
    const back = async (a: CtAsset, url: string) => {
      setStatus(`Trả màu gốc cho ${a.name}…`);
      const blob = await fetch(url).then((r) => {
        if (!r.ok) throw new Error(`Không tải được ảnh màu gốc của ${a.name}`);
        return r.blob();
      });
      await ctApi.replaceAssetFile(a.id, blob);
      const cs = a.meta?.colorSource;
      await ctApi.updateClipart(a.id, { meta: { colorSource: null, ...(cs?.variant ? { variant: cs.variant } : {}) } });
    };
    if (!originalUrl) throw new Error("Ảnh này đang là màu gốc");
    await back(one, originalUrl);
    for (const r of leadRenditions) if (r.meta?.colorSource?.url) await back(r, r.meta.colorSource.url);
    if (!one.meta?.colorSource && leadRenditions.length) out.notes.push("Bản vật liệu của ảnh này chưa đổi theo — sửa riêng từng bản nếu cần");
    return out;
  };

  const runAi = async (one: CtAsset): Promise<Outcome> => {
    const out: Outcome = { fresh: [], replaced: [], failed: [], notes: [] };
    setStatus("Đang gửi…");
    const runId = await ctApi.studioRun({
      recipe: "refine",
      params: {
        targets: [toTarget(one)],
        instruction: fix.trim(),
        keep: "",
        refs: refs.map((r) => r.name).filter((x): x is string => x !== null),
        model,
        // A vật liệu picture keeps its own canvas (plate, cord): no new cut-out.
        cutout: one.role === "rendition" ? "keep" : "category",
      },
    });
    const fresh = await waitFor(runId, (node) => (node === "FP_Cutout" ? "Tách nền…" : node === "FP_SaveToLibrary" ? "Đang lưu…" : `Đang sửa ${one.name}…`));
    out.fresh.push(...fresh);
    const next = madeFrom(one, fresh, 1);
    if (!next) throw new Error("Chạy xong nhưng không lưu ảnh nào");
    if (await swap(one, next, out)) await remakeBelow(one, next, out);
    return out;
  };

  const run = async () => {
    if (!ready || !lead) return;
    setError(null);
    try {
      const { fresh, replaced, failed, notes } = how === "free" ? (restoring ? await runRestore(lead) : await runFree(lead)) : await runAi(lead);
      setStatus(null);
      onDone(fresh, replaced);
      if (failed.length || notes.length) {
        setError([failed.length ? `Không thay được bản cũ: ${failed.join(", ")}` : "", ...notes].filter(Boolean).join(" · "));
        return;
      }
      onClose();
    } catch (e) {
      setStatus(null);
      setError(e instanceof Error ? e.message : "Không chạy được");
    }
  };

  const shown = library ? family : given;
  const freeCount = remakes.filter((x) => x.free).length;

  return (
    <CtModal open={open} onOpenChange={(o) => !o && close()} title="Sửa nhanh" wide>
      <div className="grid gap-4 text-sm md:grid-cols-[minmax(0,1fr)_280px]">
        <div className="space-y-3">
          {/* Which image */}
          <div className="space-y-1.5">
            {shown.length > 1 && <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Ảnh cần sửa</span>}
            <div className="flex flex-wrap gap-2">
              {shown.map((a) => {
                const on = a.id === lead?.id;
                return (
                  <button
                    key={a.id}
                    type="button"
                    disabled={shown.length < 2 || running}
                    onClick={() => setChosenId(a.id)}
                    className={cx("relative w-24 overflow-hidden rounded-md border text-left", on ? "border-sky-500 ring-1 ring-sky-500" : "opacity-50 hover:opacity-80")}
                    title={a.name}
                  >
                    <div className="relative aspect-square" style={CHECKER_STYLE}>
                      <img src={a.url} alt="" className="h-full w-full object-contain" />
                      <ClipartBadges asset={a} origin className="absolute inset-x-0.5 bottom-0.5" />
                    </div>
                    <div className="truncate px-1 py-0.5 text-[10px]">{a.name}</div>
                    {on && shown.length > 1 && (
                      <span className="absolute left-1 top-1 flex h-4 w-4 items-center justify-center rounded bg-sky-500 text-white">
                        <Check className="h-3 w-3" />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* How: free (no AI) or AI */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Cần sửa</span>
              <div className="ml-auto grid grid-cols-2 rounded-md bg-muted p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => setMode("free")}
                  className={cx("flex items-center gap-1 rounded px-2.5 py-1 font-medium", how === "free" ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}
                >
                  <Palette className="h-3.5 w-3.5" /> Đổi màu · <span className="text-emerald-600">miễn phí</span>
                </button>
                <button
                  type="button"
                  onClick={() => setMode("ai")}
                  className={cx("flex items-center gap-1 rounded px-2.5 py-1 font-medium", how === "ai" ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}
                >
                  <Sparkles className="h-3.5 w-3.5" /> Sửa bằng AI · <span className="text-amber-600">tốn phí</span>
                </button>
              </div>
            </div>

            {how === "free" ? (
              <div className="space-y-2.5 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-2.5">
                <p className="text-[11px] leading-snug text-muted-foreground">
                  <b className="text-foreground">Miễn phí, không gọi AI</b> (ComfyUI xử lý pixel): <b>đổi màu thân</b> của riêng ảnh này — giữ 100% nét, đổ bóng và silhouette;
                  bản vật liệu của nó đổi màu theo, các ảnh khác trong bộ giữ nguyên. Đổi góc nhìn, tư thế, kiểu dáng hay thêm / bớt chi tiết thì cần “Sửa bằng AI”.
                </p>
                <div className="space-y-1.5">
                  <div className="text-[11px] font-medium">Màu mới</div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <input
                      type="color"
                      className="h-8 w-10 cursor-pointer rounded border border-input bg-transparent"
                      value={hex || "#f7a8d8"}
                      onChange={(e) => setColour(e.target.value)}
                      disabled={running}
                    />
                    <CtInput className="h-8 w-28" value={restoring ? "" : colour} placeholder={restoring ? "màu gốc" : "#rrggbb"} onChange={(e) => setColour(e.target.value.trim())} disabled={running} />
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    <button
                      type="button"
                      disabled={running || originalUrl === null}
                      title={originalUrl ? "Màu gốc — quay lại ảnh trước khi đổi màu" : "Ảnh đang là màu gốc"}
                      onClick={() => setColour(ORIGINAL)}
                      className={cx(
                        "flex h-6 items-center gap-1 rounded-full border pl-0.5 pr-2 text-[11px] disabled:opacity-40",
                        restoring && "ring-2 ring-sky-500 ring-offset-1 ring-offset-background",
                      )}
                    >
                      <span className="h-5 w-5 overflow-hidden rounded-full border" style={CHECKER_STYLE}>
                        {originalUrl && <img src={originalUrl} alt="" className="h-full w-full object-contain" />}
                      </span>
                      Màu gốc
                    </button>
                    {QUICK_PALETTE.map((p) => (
                      <button
                        key={p.hex}
                        type="button"
                        disabled={running}
                        title={`${p.name} ${p.hex}`}
                        onClick={() => setColour(p.hex)}
                        className={cx("h-6 w-6 rounded-full border", hex.toLowerCase() === p.hex && "ring-2 ring-sky-500 ring-offset-1 ring-offset-background")}
                        style={{ background: p.hex }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <CtTextarea
                  rows={3}
                  value={fix}
                  onChange={(e) => setFix(e.target.value)}
                  placeholder="vd. mũ bị khung xe che — đưa mũ lên trên cùng, nghiêng ra ngoài cửa sổ một chút"
                  disabled={running}
                />
                <p className="text-[11px] text-muted-foreground">Gửi thẳng cho model sửa ảnh (không qua bước phân tích), kèm spec + style pack + vật liệu. Ghi cụ thể: phần nào, to / nhỏ bao nhiêu, hướng nào.</p>
                {typedColour && (
                  <div className="flex flex-wrap items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-2 text-[11px]">
                    <span className="h-4 w-4 rounded border" style={{ background: typedColour }} />
                    <span>Chỉ là đổi màu — làm miễn phí được, không cần AI.</span>
                    <CtButton
                      size="sm"
                      className="h-6 px-2 text-[11px]"
                      onClick={() => {
                        setColour(typedColour);
                        setMode("free");
                      }}
                    >
                      <Palette className="h-3 w-3" /> Đổi màu miễn phí
                    </CtButton>
                  </div>
                )}

                {/* References */}
                <div
                  className={cx("space-y-2 rounded-md border border-dashed p-2", over && "border-sky-500 bg-sky-500/10")}
                  onDragOver={(e) => {
                    const t = e.dataTransfer.types;
                    if (!t.includes("Files") && !t.includes(REF_DRAG) && !t.includes(CLIPART_DRAG)) return;
                    e.preventDefault();
                    setOver(true);
                  }}
                  onDragLeave={() => setOver(false)}
                  onDrop={onDrop}
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    {refs.map((r) => (
                      <div key={r.preview} className="relative h-14 w-14 overflow-hidden rounded border">
                        <img src={r.preview} alt="" className="h-full w-full object-cover" />
                        {r.clipart && <span className="absolute inset-x-0 bottom-0 truncate bg-sky-600/90 px-0.5 text-center text-[9px] text-white">{r.clipart.name}</span>}
                        {r.name === null ? (
                          <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-white" />
                          </div>
                        ) : (
                          <button type="button" className="absolute right-0.5 top-0.5 rounded bg-black/60 p-0.5 text-white" onClick={() => setRefs((cur) => cur.filter((x) => x !== r))} aria-label="Bỏ ảnh mẫu">
                            <X className="h-2.5 w-2.5" />
                          </button>
                        )}
                      </div>
                    ))}
                    {refs.length < MAX_REFS && (
                      <button
                        type="button"
                        onClick={() => input.current?.click()}
                        className="flex h-14 w-14 flex-col items-center justify-center gap-0.5 rounded border border-dashed text-[10px] text-muted-foreground hover:bg-accent"
                      >
                        <ImagePlus className="h-4 w-4" /> ảnh mẫu
                      </button>
                    )}
                    <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">Ảnh mẫu (tuỳ chọn): chọn file, kéo thả ảnh / clipart vào đây, hoặc chọn 1 clipart đã ưng bên dưới.</span>
                    <input
                      ref={input}
                      type="file"
                      accept="image/*"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        const files = Array.from(e.target.files ?? []);
                        e.target.value = "";
                        if (files.length) void addFiles(files);
                      }}
                    />
                  </div>
                  {candidates.length > 0 && (
                    <div className="flex gap-1.5 overflow-x-auto pb-1">
                      {candidates.map((a) => {
                        const on = refs.some((r) => r.clipart?.id === a.id);
                        return (
                          <button
                            key={a.id}
                            type="button"
                            draggable
                            onDragStart={(e) => e.dataTransfer.setData(REF_DRAG, JSON.stringify(a))}
                            onClick={() => void toggleClipart(a)}
                            disabled={!on && refs.length >= MAX_REFS}
                            title={on ? `Bỏ “${a.name}” khỏi ảnh mẫu` : `Dùng “${a.name}” làm ảnh mẫu`}
                            className={cx("relative w-14 shrink-0 overflow-hidden rounded border disabled:opacity-40", on && "border-sky-500 ring-1 ring-sky-500")}
                          >
                            <div className="aspect-square" style={CHECKER_STYLE}>
                              <img src={a.url} alt="" className="h-full w-full object-contain" loading="lazy" />
                            </div>
                            <div className="truncate px-0.5 text-[9px]">{a.name}</div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* The set's rules that go along, and what else the fix touches */}
        <aside className="h-fit space-y-3 rounded-lg border bg-muted/30 p-3 text-[11px]">
          {how === "ai" ? (
            <>
              <div className="text-xs font-semibold">Chuẩn chung (gửi kèm)</div>
              <div className="space-y-0.5">
                <div className="font-medium">Danh mục{category ? ` · ${category.name}` : ""}</div>
                <p className="line-clamp-5 leading-snug text-muted-foreground">{category?.spec || "—"}</p>
              </div>
              <div className="space-y-0.5">
                <div className="font-medium">Style pack{style ? ` · ${style.name}` : ""}</div>
                <p className="line-clamp-4 leading-snug text-muted-foreground">{style?.prompt || "không có"}</p>
              </div>
              <CtField label="Model sửa ảnh">
                <CtSelect<string> value={model} onChange={setModel} options={models.map((m) => ({ value: m, label: m }))} />
              </CtField>
              {(remakes.length > 0 || renders.length > 0) && (
                <div className="space-y-1 rounded-md border border-sky-500/40 bg-sky-500/5 p-2">
                  <div className="font-semibold text-foreground">{isRoot ? "Cả bộ gen lại theo gốc mới" : "Ảnh làm từ ảnh này gen lại theo"}</div>
                  <ul className="list-disc space-y-0.5 pl-4 leading-snug text-muted-foreground">
                    {remakes.length > 0 && (
                      <li>
                        Tạo lại {remakes.length} đa sắc: {remakes.map((x) => x.old.name).join(", ")}
                        {freeCount > 0 && ` (${freeCount === remakes.length ? "tất cả" : freeCount} đổi màu miễn phí${freeCount < remakes.length ? `, ${remakes.length - freeCount} AI` : ""})`}
                      </li>
                    )}
                    {renders.length > 0 && <li>Render lại {renders.length} bản vật liệu (AI) — preset của danh mục như lúc tạo</li>}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="text-xs font-semibold">Miễn phí (ComfyUI)</div>
              <ul className="list-disc space-y-0.5 pl-4 leading-snug text-muted-foreground">
                <li>Đổi màu thân — riêng ảnh này</li>
                {leadRenditions.length > 0 && <li>{leadRenditions.length > 1 ? `${leadRenditions.length} bản vật liệu` : "Bản vật liệu"} đổi màu theo (miễn phí)</li>}
              </ul>
              <div className="text-xs font-semibold">Cần AI</div>
              <ul className="list-disc space-y-0.5 pl-4 leading-snug text-muted-foreground">
                <li>Đổi góc nhìn / tư thế / hướng</li>
                <li>Đổi màu 1 bộ phận (vd. chỉ cái nón)</li>
                <li>Thêm / bớt / sửa chi tiết, kiểu dáng</li>
                <li>Đổi vật liệu</li>
              </ul>
            </>
          )}
          <p className="leading-snug text-muted-foreground">Ảnh sửa xong thay ảnh cũ ở mọi sản phẩm đang dùng.</p>
        </aside>
      </div>

      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
      <div className="mt-4 flex items-center justify-end gap-2">
        {running && (
          <span className="mr-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> {status} Đóng dialog vẫn chạy tiếp.
          </span>
        )}
        <CtButton onClick={close}>{running ? "Chạy nền" : "Huỷ"}</CtButton>
        <CtButton variant="primary" onClick={() => void run()} disabled={!ready}>
          {how === "free" ? <Palette className="h-3.5 w-3.5" /> : <Wand2 className="h-3.5 w-3.5" />}
          {how === "free" ? (restoring ? "Trả về màu gốc" : "Đổi màu · miễn phí") : remakes.length || renders.length ? `Sửa + gen lại ${1 + remakes.length + renders.length} ảnh` : "Sửa ảnh bằng AI"}
        </CtButton>
      </div>
    </CtModal>
  );
}
