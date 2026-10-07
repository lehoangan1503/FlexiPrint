"use client";

/**
 * "Tạo bằng AI" — the three standard jobs of a category, in order, run by the
 * ComfyUI studio behind it (server/studio.ts → services/comfy/.../recipes.py):
 *
 *   Clipart gốc   one card per clipart: a short description and / or photos of
 *                 the object. Drawn flat only (spec + style pack) — origins take
 *                 many tries, so no material version is made here
 *   Đa sắc        cliparts of the category (a gốc, or one of its vật liệu versions) →
 *                 colours (recolour, no AI) / styles (AI); a đa sắc of a vật liệu
 *                 version is a material picture itself (badges đa sắc + vật liệu)
 *   Vật liệu      origins of the category → material + the category's product
 *                 details (one version per "extra version" detail)
 *
 * The category is picked once for the three tabs; what it applies — spec, style
 * pack, materials, product details — is shown on the right, edited through the
 * category dialog. Mockups are made later from the editor's saved artworks.
 *
 * Results land in the library. The dialog keeps polling when closed, so a run
 * started here is never lost.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ChevronDown, ChevronRight, ImagePlus, Loader2, Palette, PanelRightClose, PanelRightOpen, Pencil, Plus, Search, Sparkles, Trash2, Wand2, X } from "lucide-react";
import type {
  CtAsset,
  CtClipartCategory,
  CtClipartFrame,
  CtMaterialSpec,
  CtPreset,
  CtStudioLine,
  CtRefineSuggestion,
  CtStudioRecipe,
  CtStudioRunBody,
  CtStudioRunStatus,
} from "../../types";
import { ctApi } from "../../lib/api-client";
import { flattenCategories, isMaterialClipart, isMulticolorClipart, libraryOrigins, normalizeCategoryRules } from "../../lib/library";
import { CategoryDialog, SelectWithEdit, refImage } from "../library/library-manager";
import { CHECKER_STYLE, CtButton, CtCheckbox, CtField, CtInput, CtModal, CtSelect, CtTextarea, CtTooltip, cx } from "../ui";
import { ctConfirm } from "../dialogs";
import { CLIPART_DRAG, ClipartBadges, type CtClipartDrag } from "../editor/library-panel";
import { MAX_REFS, REF_DRAG, REFINE_MODEL, numberedImage } from "./refine-shared";
import { SentenceDiff } from "./sentence-diff";
import { QuickFixDialog, quickFixKey, type CtQuickFixTarget } from "./quick-fix-dialog";

export interface CtAiTarget {
  recipe: CtStudioRecipe;
  /** Clipart gốc: preselected category. */
  categoryId?: string | null;
  /** Biến thể / Vật liệu: the library origin, with its set members (and renditions). Omitted → pick one in the dialog. */
  clipart?: CtAsset | null;
  family?: CtAsset[];
  /** Vật liệu: which of the family to render (default: the origin) — e.g. the ones a mockup still lacks. */
  targetIds?: string[];
  /** Library selection → refine-only dialog: just these cliparts + the "Chỉnh sửa" panel, no create form. */
  refine?: CtAsset[];
}

export interface CtAiResultAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export interface CtAiDialogProps {
  target: CtAiTarget | null;
  onClose: () => void;
  /** Called once per finished run with what it saved. */
  onSaved?: (assets: CtAsset[], recipe: CtStudioRecipe) => void;
  /** An old clipart was replaced by its edited version in every product using it (refine / quick fix "Thay bản cũ"). */
  onReplaced?: (old: CtAsset, next: CtAsset) => void;
  /** Per-result button (editor: "Thêm làm version", "Đặt vào vùng"…). */
  resultAction?: (asset: CtAsset, recipe: CtStudioRecipe) => CtAiResultAction | null;
}

type DialogRecipe = "origin" | "variant" | "material";

const RECIPE_TABS: Array<{ id: DialogRecipe; label: string; hint: string }> = [
  { id: "origin", label: "1. Clipart gốc", hint: "Chỉ vẽ clipart gốc (phẳng) theo spec chung + style pack" },
  { id: "variant", label: "2. Đa sắc", hint: "Clipart gốc (hoặc bản vật liệu của nó) → nhiều màu / style, giữ nguyên hình — không cần thì bỏ qua" },
  { id: "material", label: "3. Vật liệu & thành phẩm", hint: "Clipart gốc đã duyệt → vật liệu + chi tiết thành phẩm = ảnh sản phẩm hoàn chỉnh" },
];

/** The image model of every job — nano-banana (2 first): it keeps the clipart in place. */
const PREFERRED_MODELS = ["fal:fal-ai/nano-banana-2/edit", "fal:fal-ai/nano-banana/edit"];

const NODE_LABEL: Record<string, string> = {
  FP_StylePack: "Đọc style pack",
  FP_Category: "Đọc danh mục",
  FP_ContextNote: "Ghép ngữ cảnh",
  FP_Rules: "Áp rule",
  FP_OriginGenerate: "Đang vẽ clipart gốc",
  FP_Cutout: "Tách nền + chuẩn hoá",
  FP_VariantSet: "Đang tạo đa sắc",
  FP_Material: "Đang render vật liệu",
  FP_MockupScene: "Đang dựng bối cảnh",
  FP_LoadClipart: "Tải clipart",
  FP_LoadArtwork: "Tải artwork",
  FP_SaveToLibrary: "Lưu vào thư viện",
  FP_SaveMockup: "Lưu mockup",
};

/** The colours of the studio's variant template — a one-click standard palette. */
const STANDARD_PALETTE: CtStudioLine[] = [
  { name: "white", text: "#f4f1ea", mode: "recolor" },
  { name: "yellow", text: "#f6d77a", mode: "recolor" },
  { name: "pink", text: "#f7a8d8", mode: "recolor" },
  { name: "coral", text: "#f4978e", mode: "recolor" },
  { name: "green", text: "#a8e6a1", mode: "recolor" },
  { name: "mint", text: "#8fd9c4", mode: "recolor" },
  { name: "sky", text: "#8cc8f2", mode: "recolor" },
  { name: "lavender", text: "#c3a6f0", mode: "recolor" },
  { name: "charcoal", text: "#5b5b66", mode: "recolor" },
];

const HEX = /^#[0-9a-f]{6}$/i;
/** What an origin line says when the card only has photos. */
const FROM_PHOTO = "the object shown in the reference photo";

interface RefImage {
  /** ComfyUI input name ("flexiprint/…png"); null while uploading. */
  name: string | null;
  preview: string;
}

interface Subject {
  key: number;
  name: string;
  text: string;
  refs: RefImage[];
}

/** Style pack and materials come from the category — the form only picks it. */
interface OriginForm {
  /** The dialog's category — every tab works in it. */
  categoryId: string;
  subjects: Subject[];
}

/** A variant line + the photos of the look it asks for (AI lines): the image model gets them with the clipart. */
interface VariantLine extends CtStudioLine {
  pics?: RefImage[];
}

interface VariantForm {
  lines: VariantLine[];
}

interface MaterialForm {
  materialId: string;
  /** Origins besides the dialog's clipart done in the same run (one material, many cliparts). */
  more: CtAsset[];
  /** Set members (variants) rendered too — every ticked origin always is. */
  targetIds: string[];
  /**
   * Made "theo khuôn" of this product (lib/material-frame): every clipart cut to its khuôn vật liệu first, the
   * vật liệu keeps that outline — all the same size. null = theo alpha (the clipart's own outline).
   */
  frameProductId: string | null;
}

interface RunState {
  runId: string;
  recipe: CtStudioRecipe;
  startedAt: number;
  status: CtStudioRunStatus;
}

/** The category dialog opened from here (null category = a new one). */
interface Editing {
  kind: "category";
  category: CtClipartCategory | null;
  /** "Chưa hài lòng kết quả": the results to review, numbered, in "Cập nhật bằng AI". */
  review?: CtAsset[];
}

let subjectKey = 0;
function newSubject(): Subject {
  subjectKey += 1;
  return { key: subjectKey, name: "", text: "", refs: [] };
}

function emptyOrigin(categoryId: string): OriginForm {
  return { categoryId, subjects: [newSubject()] };
}

/** Results the editor picks / refines: a clipart run also saves material versions, shown on their clipart's card. */
const pickable = (list: CtAsset[]) => list.filter((a) => a.role !== "rendition" || !list.some((p) => p.id === a.parent_id));

/** Origin + its set members + renditions, from a library listing. */
function familyIn(list: CtAsset[], origin: CtAsset): CtAsset[] {
  const ids = new Set([origin.id, ...list.filter((a) => a.parent_id === origin.id).map((a) => a.id)]);
  return list.filter((a) => ids.has(a.id) || (a.parent_id !== null && ids.has(a.parent_id)));
}

/** What a closed dialog keeps for its next opening ("Lưu nháp & đóng"). Memory only: this page session. */
interface AiDraft {
  recipe: DialogRecipe;
  origin: OriginForm;
  variant: VariantForm;
  material: MaterialForm;
  results: { recipe: CtStudioRecipe; assets: CtAsset[] } | null;
  selected: string[];
  removed: string[];
  refining: boolean;
  refineDraft: RefineDraft;
  picked: CtAsset | null;
}

const drafts = new Map<string, AiDraft>();

/** The same dialog opened again: same page (product / library) and the same thing it was opened on. */
function draftKey(t: CtAiTarget): string {
  const ids = (list: CtAsset[] | undefined) => (list ?? []).map((a) => a.id).sort().join(",");
  const what = t.refine?.length
    ? `refine:${ids(t.refine)}`
    : `${t.recipe}:${t.clipart?.id ?? ""}:${t.categoryId ?? ""}`;
  return `${typeof window === "undefined" ? "" : window.location.pathname}|${what}`;
}

/**
 * What the editor typed / picked — compared on close to tell whether anything would be lost. Only fields
 * the editor sets: the ones the dialog fills by itself (category auto-pick, default material / scene, the
 * style / material carried over from the last opening) never count as a change. Blobs drop out.
 */
type DraftFields = Pick<AiDraft, "recipe" | "results" | "selected" | "removed" | "refining" | "refineDraft" | "picked"> & {
  subjects: OriginForm["subjects"];
  lines: VariantForm["lines"];
  targetIds: string[];
};

function draftFingerprint(d: DraftFields): string {
  return JSON.stringify({
    recipe: d.recipe,
    subjects: d.subjects.map((x) => ({ name: x.name, text: x.text, refs: x.refs.length })),
    lines: d.lines,
    targetIds: d.targetIds,
    results: d.results?.assets.map((a) => a.id) ?? null,
    selected: [...d.selected].sort(),
    removed: [...d.removed].sort(),
    refining: d.refining,
    refine: { ...d.refineDraft, refs: d.refineDraft.refs.map((r) => r.name ?? r.preview) },
    picked: d.picked?.id ?? null,
  });
}

const fieldsOf = (d: AiDraft): DraftFields => ({
  ...d,
  subjects: d.origin.subjects,
  lines: d.variant.lines,
  targetIds: d.material.targetIds,
});

export function CtAiDialog({ target, onClose, onSaved, onReplaced, resultAction }: CtAiDialogProps) {
  const [recipe, setRecipe] = useState<DialogRecipe>("origin");
  const [categories, setCategories] = useState<CtClipartCategory[]>([]);
  const [presets, setPresets] = useState<CtPreset[]>([]);
  const [model, setModel] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** "Sửa nhanh" open on these cliparts. */
  const [quickFix, setQuickFix] = useState<CtQuickFixTarget | null>(null);
  /** Something done that the editor should know (old cliparts swapped out of products). */
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The category panel on the right: folded to a strip for a wider form. */
  const [panelOpen, setPanelOpen] = useState(true);
  const [editing, setEditing] = useState<Editing | null>(null);

  const [origin, setOrigin] = useState<OriginForm>(() => emptyOrigin(""));
  const [variant, setVariant] = useState<VariantForm>({ lines: [] });
  const [material, setMaterial] = useState<MaterialForm>({ materialId: "", more: [], targetIds: [], frameProductId: null });
  /** Gốc id → the khuôn vật liệu of the products showing it (step 3 "theo khuôn"). */
  const [frames, setFrames] = useState<Record<string, CtClipartFrame[]>>({});

  /** Library listing for the clipart picker (Biến thể / Vật liệu without a target clipart). */
  const [library, setLibrary] = useState<CtAsset[] | null>(null);
  const [picked, setPicked] = useState<CtAsset | null>(null);

  const [run, setRun] = useState<RunState | null>(null);
  const [results, setResults] = useState<{ recipe: CtStudioRecipe; assets: CtAsset[] } | null>(null);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  /** "Chỉnh sửa" on origin results: which ones to edit, and the panel. */
  const [refining, setRefining] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** Old cliparts a refine run replaces — deleted once the new ones are saved. */
  const replacing = useRef<CtAsset[]>([]);
  const [refineDraft, setRefineDraft] = useState<RefineDraft>(emptyRefineDraft);
  const [refineHistory, setRefineHistory] = useState<RefineRound[]>([]);

  const open = target !== null;
  const stylePacks = useMemo(() => presets.filter((p) => p.kind === "style_pack"), [presets]);
  const materials = useMemo(() => presets.filter((p) => p.kind === "material"), [presets]);

  const loadCategories = useCallback(
    () =>
      ctApi
        .listCategories()
        .then((c) => setCategories(c.categories.map((x) => ({ ...x, rules: normalizeCategoryRules(x.rules) }))))
        .catch((e: Error) => setLoadError(e.message)),
    [],
  );
  const loadPresets = useCallback(
    () =>
      ctApi
        .listPresets()
        .then((p) => setPresets(p.presets))
        .catch((e: Error) => setLoadError(e.message)),
    [],
  );
  const loadLibrary = useCallback(
    () =>
      ctApi
        .listCliparts(null)
        .then(setLibrary)
        .catch((e: Error) => setLoadError(e.message)),
    [],
  );

  // Categories, presets, models once per open.
  useEffect(() => {
    if (!open) return;
    setLoadError(null);
    void loadCategories();
    void loadPresets();
    ctApi
      .studioModels()
      .then((m) => setModel(PREFERRED_MODELS.find((x) => m.includes(x)) ?? m[0] ?? ""))
      .catch((e: Error) => setLoadError(e.message));
  }, [open, loadCategories, loadPresets]);

  // Draft bookkeeping: the key of what is open, and what it looked like when it opened (null = not taken yet).
  const openKey = useRef<string | null>(null);
  const baseline = useRef<string | null>(null);
  /** The dialog a run was started from — its results go into that draft if the dialog was closed meanwhile. */
  const runKey = useRef<string | null>(null);

  // A new target resets the form to what it points at — or brings back the draft it was closed with.
  useEffect(() => {
    if (!target) {
      openKey.current = null;
      return;
    }
    const key = draftKey(target);
    openKey.current = key;
    setError(null);
    setNotice(null);
    replacing.current = [];
    const saved = drafts.get(key);
    if (saved) {
      setRecipe(saved.recipe);
      setOrigin(saved.origin);
      setVariant(saved.variant);
      setMaterial(saved.material);
      setResults(saved.results);
      setSelected(new Set(saved.selected));
      setRemoved(new Set(saved.removed));
      setRefining(saved.refining);
      setRefineDraft(saved.refineDraft);
      setPicked(saved.picked);
      // Taken from the values being set, not from state: the setters above only land on the next render.
      baseline.current = draftFingerprint(fieldsOf(saved));
      return;
    }
    const refineList = target.refine ?? [];
    const fresh: DraftFields = {
      recipe: target.recipe === "variant" || target.recipe === "material" ? target.recipe : "origin",
      results: refineList.length ? { recipe: "origin", assets: refineList } : null,
      selected: refineList.map((a) => a.id),
      removed: [],
      refining: refineList.length > 0,
      refineDraft: emptyRefineDraft(),
      picked: null,
      subjects: emptyOrigin("").subjects,
      lines: [],
      targetIds: target.targetIds?.length ? target.targetIds : target.clipart ? [target.clipart.id] : [],
    };
    setRecipe(fresh.recipe);
    setResults(fresh.results);
    setSelected(new Set(fresh.selected));
    setRefining(fresh.refining);
    setRefineDraft(fresh.refineDraft);
    setRemoved(new Set());
    setPicked(null);
    setOrigin({ ...emptyOrigin(target.categoryId ?? target.clipart?.category_id ?? ""), subjects: fresh.subjects });
    setVariant((v) => ({ ...v, lines: fresh.lines }));
    setMaterial((m) => ({ ...m, more: [], targetIds: fresh.targetIds }));
    baseline.current = draftFingerprint(fresh);
  }, [target]);

  const capture = (): AiDraft => ({
    recipe,
    origin,
    variant,
    material,
    results,
    selected: [...selected],
    removed: [...removed],
    refining,
    refineDraft,
    picked,
  });
  const fingerprint = draftFingerprint(fieldsOf(capture()));

  /**
   * Close button / X / Esc (a click outside never closes it): whatever is in the dialog is kept as its draft —
   * opening it again on the same thing brings it all back. Nothing to ask.
   */
  const requestClose = () => {
    if (target && (run || fingerprint !== baseline.current || drafts.has(draftKey(target)))) drafts.set(draftKey(target), capture());
    onClose();
  };


  // The clipart the Biến thể / Vật liệu tabs work on.
  const clip = picked ?? target?.clipart ?? null;
  const family = useMemo(() => {
    if (!clip) return [];
    if (picked && library) return familyIn(library, picked);
    return target?.family ?? [clip];
  }, [clip, picked, library, target]);
  const fixedClip = Boolean(target?.clipart) && !picked;
  // Biến thể / Vật liệu take several origins at once, ticked in the grid: the dialog's clipart first, then the others.
  const materialClips = useMemo(() => (clip ? [clip, ...material.more] : []), [clip, material.more]);
  const materialFamily = useMemo(() => {
    const more = material.more.flatMap((o) => (library ? familyIn(library, o) : [o]));
    const seen = new Set<string>();
    return [...family, ...more].filter((a) => !seen.has(a.id) && Boolean(seen.add(a.id)));
  }, [family, material.more, library]);
  // Step 3: the khuôn vật liệu of the products each ticked gốc is a version of.
  const frameOrigins = useMemo(() => (recipe === "material" ? materialClips.filter((c) => c.role !== "rendition").map((c) => c.id) : []), [recipe, materialClips]);
  useEffect(() => {
    const missing = frameOrigins.filter((id) => !(id in frames));
    if (!missing.length) return;
    let live = true;
    void Promise.all(missing.map((id) => ctApi.clipartFrames(id).then((list) => [id, list] as const).catch(() => [id, [] as CtClipartFrame[]] as const))).then((got) => {
      if (live) setFrames((cur) => ({ ...cur, ...Object.fromEntries(got) }));
    });
    return () => {
      live = false;
    };
  }, [frameOrigins, frames]);
  /** Products with a khuôn for at least one ticked gốc — and the gốc each one lacks. */
  const frameProducts = useMemo(() => {
    const byProduct = new Map<string, { frame: CtClipartFrame; has: Set<string> }>();
    for (const id of frameOrigins)
      for (const f of frames[id] ?? []) {
        const cur = byProduct.get(f.productId) ?? { frame: f, has: new Set<string>() };
        cur.has.add(id);
        byProduct.set(f.productId, cur);
      }
    return [...byProduct.values()].map(({ frame, has }) => ({ frame, missing: materialClips.filter((c) => frameOrigins.includes(c.id) && !has.has(c.id)) }));
  }, [frameOrigins, frames, materialClips]);
  const needsPicker = recipe !== "origin";
  useEffect(() => {
    if (open && needsPicker && library === null) void loadLibrary();
  }, [open, needsPicker, library, loadLibrary]);

  const categoryOptions = useMemo(
    () => [
      { value: "", label: categories.length ? "— Chọn danh mục —" : "— Chưa có danh mục, bấm + để tạo —" },
      ...flattenCategories(categories).map(({ category: c, depth }) => ({ value: c.id, label: `${"— ".repeat(depth)}${c.name}` })),
    ],
    [categories],
  );
  const category = categories.find((c) => c.id === origin.categoryId) ?? null;
  const styleOf = (c: CtClipartCategory | null) => stylePacks.find((p) => p.id === c?.rules.stylePackId) ?? null;
  // Refined cliparts are re-read with their category's context (spec + default style pack).
  // Mixed categories (a library selection can span several): no spec update, the style pack stays unknown.
  const refineCatIds = new Set(pickable(results?.assets ?? []).map((a) => a.category_id));
  const refineCategory = refineCatIds.size === 1 ? (categories.find((c) => c.id === results?.assets[0]?.category_id) ?? null) : null;
  const refineStyle = styleOf(refineCategory);
  const historyCategoryId = refineCategory?.id ?? null;
  useEffect(() => {
    if (open) setRefineHistory(readHistory(historyCategoryId));
  }, [open, historyCategoryId]);

  // Only one category → it's the one.
  useEffect(() => {
    if (!origin.categoryId && categories.length === 1) setOrigin((o) => ({ ...o, categoryId: categories[0].id }));
  }, [origin.categoryId, categories]);

  // Vật liệu: the category's first material, unless the editor picked another one that still exists.
  const categoryMaterialIds = category?.rules.materialIds ?? [];
  const firstMaterial = categoryMaterialIds.find((id) => materials.some((m) => m.id === id)) ?? materials[0]?.id ?? "";
  useEffect(() => {
    setMaterial((m) => (m.materialId && materials.some((x) => x.id === m.materialId) ? m : { ...m, materialId: firstMaterial }));
  }, [firstMaterial, materials]);

  /** Another category: a clipart picked from the old one leaves (the one the dialog was opened on stays). */
  const pickCategory = (categoryId: string) => {
    setOrigin((o) => ({ ...o, categoryId }));
    if (picked && picked.category_id !== categoryId) {
      setPicked(null);
      setMaterial((m) => ({ ...m, more: [], targetIds: [], materialId: "" }));
    } else setMaterial((m) => ({ ...m, materialId: "" }));
  };

  // ------------------------------------------------------------------ run

  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (poll.current) clearTimeout(poll.current);
    },
    [],
  );

  const watch = useCallback(
    (runId: string, runRecipe: CtStudioRecipe) => {
      const tick = async () => {
        try {
          const status = await ctApi.studioRunStatus(runId);
          setRun((r) => (r && r.runId === runId ? { ...r, status } : r));
          if (status.status === "done" || status.status === "error") {
            setRun(null);
            if (status.status === "error") setError(status.error ?? "Chạy thất bại");
            const old = replacing.current;
            replacing.current = [];
            // Material versions ride along with their clipart: only the cliparts take the old ones' places.
            if (status.assets.length && old.length) void dropReplaced(old, pickable(status.assets));
            const k = runKey.current;
            if (status.assets.length && k && k !== openKey.current && drafts.has(k)) {
              const d = drafts.get(k)!;
              drafts.set(k, { ...d, results: { recipe: runRecipe, assets: status.assets }, selected: pickable(status.assets).map((a) => a.id), removed: [] });
            }
            if (status.assets.length) {
              setResults({ recipe: runRecipe, assets: status.assets });
              setSelected(new Set(pickable(status.assets).map((a) => a.id)));
              setLibrary(null);
              onSaved?.(status.assets, runRecipe);
            } else if (status.status === "done") setError("Chạy xong nhưng không lưu ảnh nào");
            return;
          }
        } catch (e) {
          // A blip (dev server reload…): keep watching.
          setRun((r) => (r && r.runId === runId ? { ...r, status: { ...r.status, error: e instanceof Error ? e.message : String(e) } } : r));
        }
        poll.current = setTimeout(() => void tick(), 2000);
      };
      poll.current = setTimeout(() => void tick(), 1500);
    },
    [onSaved],
  );

  /**
   * Refine "Thay bản cũ": each edited version takes its old clipart's place — products that used the old one
   * now show the new one (server replaceClipart), then the old one is deleted. Old ↔ new pair up by
   * meta.derivedFrom (two cliparts may share a name).
   */
  const dropReplaced = async (old: CtAsset[], fresh: CtAsset[]) => {
    const failed: string[] = [];
    const swapped: string[] = [];
    const free = [...fresh];
    for (const a of old) {
      // The refine saves meta.derivedFrom = the clipart it edited; older studio builds: same name.
      let k = free.findIndex((n) => n.meta?.derivedFrom === a.id);
      if (k < 0) k = free.findIndex((n) => !n.meta?.derivedFrom && n.name === a.name);
      const next = k >= 0 ? free.splice(k, 1)[0] : undefined;
      try {
        if (next && next.role === a.role) {
          const { usage } = await ctApi.replaceClipart(a.id, next.id);
          onReplaced?.(a, next);
          if (usage.length) swapped.push(`${a.name} (${usage.map((u) => u.productName).join(", ")})`);
        } else await ctApi.deleteClipart(a.id);
      } catch {
        failed.push(a.name);
      }
    }
    if (failed.length) setError(`Không thay được bản cũ: ${failed.join(", ")}`);
    else if (swapped.length) setNotice(`Đã thay ảnh mới vào sản phẩm đang dùng: ${swapped.join("; ")} — publish lại để storefront cập nhật.`);
  };

  /** Refine: save the spec / style rewrite if asked, then edit the selected cliparts. */
  const applyRefine = async (r: RefineApply) => {
    const targets = pickable(results?.assets ?? []).filter((a) => selected.has(a.id) && !removed.has(a.id));
    if (!targets.length) return setError("Chọn ít nhất 1 ảnh để sửa");
    if (!r.model) return setError("Chưa có model — ComfyUI studio đang chạy chưa?");
    setBusy(true);
    setError(null);
    const round: RefineRound = {
      at: new Date().toISOString(),
      keep: r.keep,
      fix: refineDraft.fix.trim(),
      instruction: r.instruction,
      model: r.model,
      images: targets.map((a) => a.name),
      own: targets.map((a) => ({ name: a.name, edit: r.own[a.id]?.edit ?? "" })).filter((x) => x.edit),
      refs: r.refs.length,
      spec: r.spec !== null && refineCategory ? { before: refineCategory.spec, after: r.spec } : null,
      style: r.style !== null && refineStyle ? { name: refineStyle.name, before: refineStyle.prompt, after: r.style } : null,
    };
    try {
      if (r.spec !== null && refineCategory) {
        const c = refineCategory;
        await ctApi.updateCategory(c.id, { name: c.name, parent_id: c.parent_id, usage: c.usage, mode: c.mode, spec: r.spec, rules: c.rules, sort_order: c.sort_order });
        void loadCategories();
      }
      if (r.style !== null && refineStyle) {
        const p = refineStyle;
        await ctApi.updatePreset(p.id, { kind: p.kind, name: p.name, prompt: r.style, reference_asset_ids: p.reference_asset_ids, params: p.params });
        void loadPresets();
      }
      const runId = await ctApi.studioRun({
        recipe: "refine",
        params: {
          // Edited flat only: material versions are made from the Vật liệu tab once the origin is right.
          targets: targets.map((a) => ({
            clipart_id: a.id,
            name: a.name,
            edit: r.own[a.id]?.edit ?? "",
            spec: r.own[a.id]?.spec ?? a.spec,
            materials: [],
          })),
          instruction: r.instruction,
          keep: r.keep,
          refs: r.refs,
          model: r.model,
          cutout: "category",
        },
      });
      const history = [round, ...refineHistory].slice(0, HISTORY_MAX);
      setRefineHistory(history);
      writeHistory(historyCategoryId, history);
      replacing.current = r.replace ? targets : [];
      runKey.current = openKey.current;
      setResults(null);
      setRemoved(new Set());
      // The panel (and what was typed) comes back with the new images.
      setRun({ runId, recipe: "origin", startedAt: Date.now(), status: { status: "queued", assets: [] } });
      watch(runId, "origin");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không chạy được");
    } finally {
      setBusy(false);
    }
  };

  const body = (): Exclude<CtStudioRunBody, { recipe: "refine" | "adjust" | "artwork_material" | "mockup_enhance" | "mockup" }> | string => {
    if (!model) return "Chưa có model — ComfyUI studio đang chạy chưa?";
    if (recipe === "origin") {
      if (!origin.categoryId || !category) return "Chọn danh mục (hoặc bấm + để tạo)";
      const cards = origin.subjects.filter((s) => s.text.trim() || s.refs.length);
      if (!cards.length) return "Mô tả clipart cần tạo hoặc thêm ảnh của vật";
      if (cards.some((s) => s.refs.some((r) => r.name === null))) return "Đợi ảnh tham chiếu upload xong";
      return {
        recipe,
        params: {
          category_id: origin.categoryId,
          // The category's style pack; drawn flat only — material versions come from the Vật liệu tab, once the
          // origin is approved (an origin takes many tries; a material version of each try would be wasted).
          style_pack_id: null,
          material_id: null,
          material_extra: "",
          material_ids: [],
          note: "",
          subjects: cards.map((s) => ({
            name: s.name,
            text: s.text.trim() || FROM_PHOTO,
            refs: s.refs.map((r) => r.name).filter((n): n is string => n !== null),
          })),
          model,
          chain_reference: true,
          cutout: "category",
          rules: {},
          tags: [],
        },
      };
    }
    if (recipe === "variant") {
      if (!clip) return "Chọn ít nhất 1 clipart gốc";
      const kept = variant.lines.filter((l) => l.text.trim());
      if (!kept.length) return "Thêm ít nhất 1 đa sắc (màu hoặc style AI)";
      const bad = kept.find((l) => l.mode === "recolor" && !HEX.test(l.text.trim()));
      if (bad) return `“${bad.name || bad.text}”: đổi màu cần mã #rrggbb`;
      if (kept.some((l) => l.pics?.some((r) => r.name === null))) return "Đợi ảnh tham khảo upload xong";
      // AI lines bring their reference photos (ComfyUI input names); a colour line needs none.
      const lines: CtStudioLine[] = kept.map(({ pics, ...l }) => {
        const refs = l.mode === "recolor" ? [] : (pics ?? []).map((r) => r.name).filter((n): n is string => n !== null);
        return refs.length ? { ...l, refs } : l;
      });
      // Every ticked origin gets the same lines, in one run.
      return { recipe, params: { clipart_id: clip.id, clipart_ids: materialClips.map((c) => c.id), variants: lines, method: "auto", lock_silhouette: true, model } };
    }
    if (recipe === "material") {
      if (!clip) return "Chọn 1 clipart gốc";
      if (!material.materialId) return "Chọn vật liệu (hoặc bấm + để tạo)";
      const preset = materials.find((m) => m.id === material.materialId);
      const ids = new Set([...materialClips.map((c) => c.id), ...material.targetIds]);
      // A vật liệu version (picked as a đa sắc source) is no source of another material.
      const chosen = materialFamily.filter((a) => ids.has(a.id) && a.role !== "rendition");
      const product = material.frameProductId ? frameProducts.find((p) => p.frame.productId === material.frameProductId) : null;
      if (material.frameProductId && !product) return "Sản phẩm của khuôn không còn — chọn lại khuôn";
      if (product?.missing.length) return `${product.missing.map((c) => `“${c.name}”`).join(", ")} chưa có khuôn trong “${product.frame.productName}” — bỏ chọn, hoặc làm theo alpha`;
      const targets = chosen.map((a) => {
        const name = `${a.name} · ${preset?.name ?? "vật liệu"}`;
        if (!product) return { clipart_id: a.id, name };
        // A đa sắc is cut like its gốc: it is drawn in the gốc's version frame.
        const gocId = materialClips.some((c) => c.id === a.id) ? a.id : (a.parent_id ?? a.id);
        const f = (frames[gocId] ?? []).find((x) => x.productId === product.frame.productId) ?? product.frame;
        return { clipart_id: a.id, name: `${name} · khuôn ${f.productName}`, frame: { cut: f.cut, meta: { productId: f.productId, regionId: f.regionId, box: f.box } } };
      });
      if (!targets.length) return "Chọn ít nhất 1 clipart";
      return { recipe, params: { material_id: material.materialId, targets, lock: "preset", edge_px: 0, extra: "", model } };
    }
    return "Chọn 1 bước";
  };

  const start = async () => {
    const b = body();
    if (typeof b === "string") return setError(b);
    setBusy(true);
    setError(null);
    setResults(null);
    setRemoved(new Set());
    setRefining(false);
    replacing.current = [];
    try {
      const runId = await ctApi.studioRun(b);
      setRun({ runId, recipe: b.recipe, startedAt: Date.now(), status: { status: "queued", assets: [] } });
      runKey.current = openKey.current;
      watch(runId, b.recipe);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không chạy được");
    } finally {
      setBusy(false);
    }
  };

  const discard = async (a: CtAsset) => {
    const used = a.product_id === null ? await ctApi.clipartUsage(a.id).catch(() => []) : [];
    const ok = await ctConfirm(
      used.length
        ? {
            title: "Element đang được dùng trong sản phẩm",
            message: `“${a.name}” đang được dùng trong ${used.length} sản phẩm: ${used.map((u) => u.productName).join(", ")}.\n\nXoá sẽ gỡ luôn element này khỏi các sản phẩm đó. Chắc chắn muốn xoá?`,
            tone: "danger",
            confirmLabel: "Xoá & gỡ khỏi sản phẩm",
          }
        : { title: `Xoá “${a.name}”?`, tone: "danger", confirmLabel: "Xoá" },
    );
    if (!ok) return;
    try {
      await (a.product_id === null ? ctApi.deleteClipart(a.id, used.length > 0) : ctApi.deleteAsset(a.id));
      setRemoved((s) => new Set(s).add(a.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Xoá thất bại");
    }
  };

  /** A fresh origin → straight to its variants. */
  const continueWith = (a: CtAsset, next: "variant" | "material") => {
    setPicked(a);
    setLibrary(null);
    setRecipe(next);
    setResults(null);
    setVariant((v) => ({ ...v, lines: [] }));
    setMaterial((m) => ({ ...m, more: [], targetIds: [a.id], frameProductId: null }));
  };

  /**
   * Biến thể / Vật liệu: the ticked origins, in one update (the dialog's clipart stays first). An origin that
   * leaves takes its variants out of the material run.
   */
  const setChosen = (list: CtAsset[]) => {
    const rest = fixedClip && clip ? list.filter((a) => a.id !== clip.id) : list.slice(1);
    if (!fixedClip) setPicked(list[0] ?? null);
    const keep = new Set(list.map((a) => a.id));
    const members = new Set((library ?? []).filter((a) => a.parent_id !== null && keep.has(a.parent_id)).map((a) => a.id));
    setMaterial((m) => ({ ...m, more: rest, targetIds: m.targetIds.filter((id) => members.has(id)) }));
  };
  const toggleMaterialClip = (a: CtAsset) =>
    setChosen(materialClips.some((c) => c.id === a.id) ? materialClips.filter((c) => c.id !== a.id || c.id === (fixedClip ? clip?.id : null)) : [...materialClips, a]);

  const tab = RECIPE_TABS.find((t) => t.id === recipe) ?? RECIPE_TABS[0];
  const refineOnly = Boolean(target?.refine?.length);
  // Still the library's own cliparts (no refine run finished yet).
  const fromLibrary = refineOnly && results !== null && results.assets.every((a) => target?.refine?.some((r) => r.id === a.id));
  /** Biến thể / Vật liệu pick among the category's own origins. */
  const categoryLibrary = useMemo(() => (library === null ? null : library.filter((a) => a.category_id === origin.categoryId)), [library, origin.categoryId]);
  const categoryMaterials = categoryMaterialIds.map((id) => materials.find((m) => m.id === id)).filter((m): m is CtPreset => Boolean(m));

  return (
    <>
      <CtModal open={open} onOpenChange={(o) => !o && requestClose()} title={refineOnly ? "Chỉnh sửa bằng AI" : "Tạo bằng AI"} wide keepOpenOnOutside>
        <div className="flex flex-col gap-4 text-sm">
          {!refineOnly && (
          <div className="flex flex-wrap items-center gap-1 rounded-lg border p-1">
            {RECIPE_TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setRecipe(t.id)}
                className={cx("rounded-md px-3 py-1.5 text-xs font-medium", recipe === t.id ? "bg-foreground text-background shadow-sm" : "text-muted-foreground hover:bg-accent hover:text-foreground")}
              >
                {t.label}
              </button>
            ))}
            <span className="ml-auto px-2 text-[11px] text-muted-foreground">{tab.hint}</span>
          </div>
          )}

          {loadError && <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{loadError}</p>}

          {refineOnly ? null : (
            <div className={cx("grid gap-4", panelOpen ? "md:grid-cols-[1fr_340px]" : "md:grid-cols-[1fr_36px]")}>
              <div className="min-w-0 space-y-3">
                <CtField
                  label="Danh mục"
                  hint={fixedClip ? "Theo clipart đang chọn." : "Cả 3 bước làm trong danh mục này — spec chung, style pack, vật liệu và chi tiết thành phẩm lấy từ danh mục (bên phải)."}
                >
                  <SelectWithEdit<string>
                    value={origin.categoryId}
                    onChange={pickCategory}
                    options={categoryOptions}
                    disabled={fixedClip}
                    onNew={() => setEditing({ kind: "category", category: null })}
                    newLabel="Danh mục mới"
                  />
                </CtField>
                {recipe === "origin" && (
                  <OriginFields
                    form={origin}
                    setSubjects={(fn) => setOrigin((o) => ({ ...o, subjects: fn(o.subjects) }))}
                    onError={setError}
                  />
                )}
                {recipe !== "origin" && !category && !fixedClip && (
                  <p className="rounded-md border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">Chọn danh mục trước.</p>
                )}
                {recipe !== "origin" && (category || fixedClip) && !clip && categoryLibrary !== null && libraryOrigins(categoryLibrary).length === 0 && (
                  <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-4 text-center text-xs">
                    <p>
                      Danh mục <b>{category?.name}</b> chưa có clipart gốc. Tạo clipart gốc cho danh mục này trước — đa sắc và vật liệu luôn làm từ clipart gốc đã duyệt.
                    </p>
                    <CtButton size="sm" onClick={() => setRecipe("origin")}>
                      <ArrowLeft className="h-3.5 w-3.5" /> Sang bước 1 · Clipart gốc
                    </CtButton>
                  </div>
                )}
                {recipe !== "origin" && (category || fixedClip) && (clip || (categoryLibrary !== null && libraryOrigins(categoryLibrary).length > 0)) && (
                  <OriginGrid
                    clips={materialClips}
                    fixedId={fixedClip ? (clip?.id ?? null) : null}
                    library={categoryLibrary}
                    withMaterials={recipe === "variant"}
                    onToggle={toggleMaterialClip}
                    onAll={(on) => setChosen(on ? [...materialClips, ...sources(categoryLibrary ?? [], recipe === "variant").filter((o) => !materialClips.some((c) => c.id === o.id))] : materialClips.filter((c) => fixedClip && c.id === clip?.id))}
                  />
                )}
                {recipe === "variant" && (category || fixedClip) && (
                  <p className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                    Sản phẩm không cần đa sắc? Bỏ qua bước này. Muốn đa sắc của bản vật liệu: làm vật liệu (bước 3) trước, rồi chọn bản vật liệu ở đây.
                    <button className="inline-flex items-center gap-0.5 font-medium text-sky-600 hover:underline" onClick={() => setRecipe("material")}>
                      Sang bước 3 · Vật liệu & thành phẩm <ArrowRight className="h-3 w-3" />
                    </button>
                  </p>
                )}
                {recipe === "variant" && clip && (
                  <VariantFields
                    form={variant}
                    set={(p) => setVariant((v) => ({ ...v, ...p }))}
                    patchPics={(fn) => setVariant((v) => ({ ...v, lines: v.lines.map((l) => (l.pics ? { ...l, pics: fn(l.pics) } : l)) }))}
                    onError={setError}
                    members={materialFamily.filter((a) => isMulticolorClipart(a) && materialClips.some((c) => c.id === a.parent_id))}
                  />
                )}
                {recipe === "material" && clip && (
                  <MaterialFields
                    form={material}
                    set={(p) => setMaterial((m) => ({ ...m, ...p }))}
                    materials={materials}
                    categoryMaterials={categoryMaterials}
                    details={category?.rules.details ?? []}
                    groups={materialClips.filter((o) => o.role !== "rendition").map((o) => ({
                      origin: o,
                      items: materialFamily.filter((a) => a.role !== "rendition" && (a.id === o.id || a.parent_id === o.id)),
                    }))}
                  />
                )}
                {recipe === "material" && clip && (
                  <FrameFields
                    value={material.frameProductId}
                    onChange={(frameProductId) => setMaterial((m) => ({ ...m, frameProductId }))}
                    products={frameProducts}
                    loading={frameOrigins.some((id) => !(id in frames))}
                  />
                )}
              </div>

              <CategoryPanel
                category={category}
                style={styleOf(category)}
                materials={categoryMaterials}
                open={panelOpen}
                onToggle={() => setPanelOpen((v) => !v)}
                onEdit={(c) => setEditing({ kind: "category", category: c })}
              />
            </div>
          )}

          {run && <RunProgress run={run} />}
          {error && <p className="text-xs text-destructive">{error}</p>}
          {notice && <p className="text-xs text-emerald-600">{notice}</p>}

          {results && (
            <div className="space-y-2 rounded-lg border p-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold">
                  {fromLibrary
                    ? `${results.assets.length} clipart từ thư viện`
                    : `Đã lưu ${pickable(results.assets).length} ảnh${
                        pickable(results.assets).length < results.assets.length ? ` + ${results.assets.length - pickable(results.assets).length} bản vật liệu` : ""
                      } ${results.recipe === "mockup" ? "vào sản phẩm" : "vào thư viện"}`}
                </span>
                <span className="ml-auto flex gap-1.5">
                  {results.recipe === "origin" && !refining && (
                    <CtTooltip label="Sửa trực tiếp các ảnh này bằng AI (không đổi prompt của danh mục, trừ khi bạn chọn)">
                      <span>
                        <CtButton size="sm" onClick={() => setRefining(true)} disabled={run !== null}>
                          <Wand2 className="h-3.5 w-3.5" /> Sửa ảnh
                        </CtButton>
                      </span>
                    </CtTooltip>
                  )}
                  {refineCategory && !fromLibrary && (
                    <CtTooltip label="Mở danh mục ở “Cập nhật bằng AI” với toàn bộ ảnh kết quả (đánh số) — mô tả chỗ chưa ưng để AI sửa spec chung / style pack / vật liệu / chi tiết thành phẩm, lần tạo sau ra đúng">
                      <span>
                        <CtButton
                          size="sm"
                          variant="primary"
                          onClick={() => setEditing({ kind: "category", category: refineCategory, review: results.assets.filter((a) => !removed.has(a.id)) })}
                          disabled={run !== null}
                        >
                          <Sparkles className="h-3.5 w-3.5" /> Chưa hài lòng kết quả, cần điều chỉnh lại
                        </CtButton>
                      </span>
                    </CtTooltip>
                  )}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-6">
                {pickable(results.assets)
                  .filter((a) => !removed.has(a.id))
                  .map((a, _i, shown) => {
                    const versions = results.assets.filter((r) => r.role === "rendition" && r.parent_id === a.id && !removed.has(r.id));
                    // The number the refine analysis sees on this image ("hình 1" = #1): its place among the selected ones.
                    const number = refining && selected.has(a.id) ? shown.filter((x) => selected.has(x.id)).indexOf(a) + 1 : 0;
                    const action = resultAction?.(a, results.recipe) ?? null;
                    const on = selected.has(a.id);
                    return (
                      <div
                        key={a.id}
                        className={cx("space-y-1 rounded-md border p-1", refining && on && "border-sky-500 ring-1 ring-sky-500")}
                        draggable={refining}
                        onDragStart={(e) => {
                          // Onto "Ảnh mẫu": this clipart becomes the reference for the others.
                          e.dataTransfer.effectAllowed = "copy";
                          e.dataTransfer.setData(REF_DRAG, JSON.stringify(a));
                        }}
                      >
                        {refining ? (
                          <button
                            className="relative block aspect-square w-full overflow-hidden rounded"
                            style={CHECKER_STYLE}
                            onClick={() =>
                              setSelected((cur) => {
                                const next = new Set(cur);
                                if (next.has(a.id)) next.delete(a.id);
                                else next.add(a.id);
                                return next;
                              })
                            }
                            title={on ? "Bỏ chọn" : "Chọn để sửa"}
                          >
                            <img src={a.url} alt={a.name} className={cx("h-full w-full object-contain", !on && "opacity-40")} />
                            <span className={cx("absolute left-1 top-1 flex h-4 w-4 items-center justify-center rounded border", on ? "border-sky-500 bg-sky-500 text-white" : "border-white/70 bg-black/40")}>
                              {on && <Check className="h-3 w-3" />}
                            </span>
                            {number > 0 && (
                              <span className="absolute right-1 top-1 rounded-full bg-black/80 px-1.5 text-[11px] font-bold leading-5 text-white">#{number}</span>
                            )}
                          </button>
                        ) : (
                          <a href={a.url} target="_blank" rel="noreferrer" className="block aspect-square overflow-hidden rounded" style={CHECKER_STYLE}>
                            <img src={a.url} alt={a.name} className="h-full w-full object-contain" />
                          </a>
                        )}
                        <div className="truncate text-[11px]" title={a.name}>
                          {a.name}
                        </div>
                        {versions.length > 0 && (
                          <div className="flex gap-1">
                            {versions.map((r) => (
                              <a
                                key={r.id}
                                href={r.url}
                                target="_blank"
                                rel="noreferrer"
                                className="h-8 w-8 overflow-hidden rounded border border-violet-500/50"
                                style={CHECKER_STYLE}
                                title={`${r.name} · bản vật liệu`}
                              >
                                <img src={r.url} alt={r.name} className="h-full w-full object-contain" />
                              </a>
                            ))}
                          </div>
                        )}
                        {refineOnly ? (
                          // Editing library cliparts: one image at a time without the analysis round.
                          <CtButton size="sm" className="h-6 w-full px-1 text-[10px]" onClick={() => setQuickFix({ assets: [a] })} disabled={run !== null}>
                            <Wand2 className="h-3 w-3" /> Sửa nhanh
                          </CtButton>
                        ) : (
                          <>
                        {action && (
                          <CtButton size="sm" variant="primary" className="h-6 w-full px-1 text-[10px]" onClick={action.onClick} disabled={action.disabled}>
                            {action.label}
                          </CtButton>
                        )}
                        <div className="flex gap-1">
                          {results.recipe === "origin" && (
                            <>
                              <CtButton size="sm" className="h-6 flex-1 px-1 text-[10px]" onClick={() => continueWith(a, "variant")} title="Bước 2: đa sắc màu / style">
                                Đa sắc <ArrowRight className="h-3 w-3" />
                              </CtButton>
                              <CtButton size="sm" className="h-6 flex-1 px-1 text-[10px]" onClick={() => continueWith(a, "material")} title="Bước 3: vật liệu + chi tiết thành phẩm">
                                Vật liệu <ArrowRight className="h-3 w-3" />
                              </CtButton>
                            </>
                          )}
                          <button className="rounded p-1 text-destructive opacity-70 hover:bg-accent hover:opacity-100" onClick={() => void discard(a)} title="Xoá ảnh này">
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                          </>
                        )}
                      </div>
                    );
                  })}
              </div>
              {refining && (
                <RefinePanel
                  assets={pickable(results.assets).filter((a) => selected.has(a.id) && !removed.has(a.id))}
                  shown={pickable(results.assets).filter((a) => !removed.has(a.id))}
                  total={pickable(results.assets).filter((a) => !removed.has(a.id)).length}
                  category={refineCategory}
                  style={refineStyle}
                  defaultModel={REFINE_MODEL}
                  draft={refineDraft}
                  onDraft={setRefineDraft}
                  history={refineHistory}
                  busy={busy}
                  onApply={(r) => void applyRefine(r)}
                  onClose={() => setRefining(false)}
                  onError={setError}
                />
              )}
            </div>
          )}

          {refineOnly ? (
            <div className="flex justify-end border-t pt-3">
              <CtButton onClick={() => requestClose()}>{run ? "Chạy nền" : "Đóng"}</CtButton>
            </div>
          ) : (
          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <div className="ml-auto flex gap-2">
              <CtButton onClick={() => requestClose()}>{run ? "Chạy nền" : "Đóng"}</CtButton>
              <CtButton variant="primary" onClick={() => void start()} disabled={busy || run !== null}>
                {busy || run ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                {results ? "Tạo tiếp" : "Tạo"}
              </CtButton>
            </div>
          </div>
          )}
        </div>
      </CtModal>
      <QuickFixDialog
        key={quickFixKey(quickFix)}
        target={quickFix}
        onClose={() => setQuickFix(null)}
        onDone={(fresh, replaced) => {
          // The edited image takes the old one's card (or joins the list when the old one was kept).
          setResults((cur) => {
            if (!cur) return cur;
            const swap = new Map(replaced.map((r) => [r.old.id, r.next]));
            const kept = cur.assets.map((a) => swap.get(a.id) ?? a);
            const extra = fresh.filter((f) => f.role !== "rendition" && !kept.some((a) => a.id === f.id));
            return { ...cur, assets: [...kept, ...extra] };
          });
          setSelected((cur) => new Set([...cur].map((id) => replaced.find((r) => r.old.id === id)?.next.id ?? id)));
          for (const r of replaced) onReplaced?.(r.old, r.next);
          onSaved?.(fresh, "origin");
          if (replaced.length) setNotice(`Đã sửa nhanh: ${replaced.map((r) => r.next.name).join(", ")} — sản phẩm đang dùng đã thay ảnh mới.`);
        }}
      />

      {editing?.kind === "category" && (
        <CategoryDialog
          key={`${editing.category?.id ?? "new"}-${editing.review?.length ?? 0}`}
          category={editing.category}
          review={editing.review}
          categories={categories}
          stylePacks={stylePacks}
          materials={materials}
          onPresetsChanged={() => void loadPresets()}
          onClose={() => setEditing(null)}
          onSaved={(c) => {
            void loadCategories();
            setOrigin((o) => ({ ...o, categoryId: c.id }));
          }}
          onDeleted={() => {
            void loadCategories();
            setOrigin((o) => ({ ...o, categoryId: "" }));
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Refine: feedback on the results → AI edit (+ spec / style update)
// ---------------------------------------------------------------------------

/** One clipart's part of a refine: fixes for it only, and its own description (saved as its spec). */
interface RefineOwn {
  edit: string;
  spec: string;
}

interface RefineApply {
  /** The shared change (end state for every clipart); may be empty when only single images change. */
  instruction: string;
  /** Asset id → its own fixes / description. */
  own: Record<string, RefineOwn>;
  keep: string;
  /** ComfyUI input names of the reference photos. */
  refs: string[];
  /** New spec / style prompt to save first, or null to leave it. */
  spec: string | null;
  style: string | null;
  replace: boolean;
  model: string;
}

interface RefineRef {
  preview: string;
  blob: Blob;
  /** ComfyUI input name once uploaded. */
  name: string | null;
  /** A clipart of the set used as the reference (one that already came out right); absent = a photo. */
  clipart?: { id: string; name: string };
}

/** Everything typed in the "Chỉnh sửa" panel — held by the dialog so a run doesn't wipe it. */
interface RefineDraft {
  fix: string;
  /** The AI's keep-list (everything the request doesn't mention), editable. */
  keep: string;
  refs: RefineRef[];
  updateSpec: boolean;
  updateStyle: boolean;
  plan: CtRefineSuggestion | null;
  instruction: string;
  /** Asset id → its own fixes / description (from the analysis, editable). */
  own: Record<string, RefineOwn>;
  spec: string;
  styleText: string;
  saveSpec: boolean;
  saveStyle: boolean;
  replace: boolean;
  /** "" = the dialog's model. */
  model: string;
}

function emptyRefineDraft(): RefineDraft {
  return { fix: "", keep: "", refs: [], updateSpec: true, updateStyle: false, plan: null, instruction: "", own: {}, spec: "", styleText: "", saveSpec: true, saveStyle: true, replace: true, model: "" };
}

/** One applied round, kept per category (browser storage) so the editor sees what was asked and what changed. */
interface RefineRound {
  at: string;
  /** What was kept: the AI's keep-list (older rounds: what the editor typed). */
  keep: string;
  fix: string;
  instruction: string;
  model: string;
  images: string[];
  /** Per-image fixes sent with this round (older rounds: none). */
  own?: Array<{ name: string; edit: string }>;
  refs: number;
  spec: { before: string; after: string } | null;
  style: { name: string; before: string; after: string } | null;
}

const HISTORY_MAX = 20;

const historyKey = (categoryId: string | null) => `fp.refine.history.${categoryId ?? "none"}`;

function readHistory(categoryId: string | null): RefineRound[] {
  try {
    const raw = window.localStorage.getItem(historyKey(categoryId));
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? (list as RefineRound[]) : [];
  } catch {
    return [];
  }
}

function writeHistory(categoryId: string | null, list: RefineRound[]): void {
  try {
    window.localStorage.setItem(historyKey(categoryId), JSON.stringify(list.slice(0, HISTORY_MAX)));
  } catch {
    // Private window / storage full: the history just isn't kept.
  }
}

function RefinePanel(props: {
  assets: CtAsset[];
  /** Every clipart on show in the dialog (selected or not) — candidates for a reference. */
  shown: CtAsset[];
  total: number;
  category: CtClipartCategory | null;
  style: CtPreset | null;
  defaultModel: string;
  draft: RefineDraft;
  onDraft: (fn: (d: RefineDraft) => RefineDraft) => void;
  history: RefineRound[];
  busy: boolean;
  onApply: (r: RefineApply) => void;
  onClose: () => void;
  onError: (msg: string) => void;
}) {
  const { category, style, draft } = props;
  const set = (patch: Partial<RefineDraft>) => props.onDraft((d) => ({ ...d, ...patch }));
  const canSpec = Boolean(category?.can_edit);
  const canStyle = Boolean(style?.can_edit);
  const [analyzing, setAnalyzing] = useState(false);
  const [over, setOver] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  const model = draft.model || props.defaultModel;

  /** The category's other origins: one that came out right is the best reference for the rest. */
  const [loaded, setLoaded] = useState<{ categoryId: string; list: CtAsset[] } | null>(null);
  const categoryId = category?.id ?? null;
  useEffect(() => {
    if (!categoryId) return;
    let live = true;
    ctApi
      .listCliparts(categoryId)
      .then((list) => live && setLoaded({ categoryId, list: list.filter((a) => a.parent_id === null && a.role !== "rendition") }))
      .catch(() => live && setLoaded({ categoryId, list: [] }));
    return () => {
      live = false;
    };
  }, [categoryId]);
  const pool = loaded && loaded.categoryId === categoryId ? loaded.list : [];
  const targetIds = new Set(props.assets.map((a) => a.id));
  // Same category, not being edited now: library origins plus what the dialog shows.
  const candidates = [...new Map([...props.shown, ...pool].filter((a) => !targetIds.has(a.id) && (!categoryId || a.category_id === categoryId)).map((a) => [a.id, a])).values()];

  const addRef = async (blob: Blob, clipart?: RefineRef["clipart"]) => {
    const preview = URL.createObjectURL(blob);
    props.onDraft((d) => (d.refs.length >= MAX_REFS ? d : { ...d, refs: [...d.refs, { preview, blob, name: null, clipart }] }));
    try {
      const name = await ctApi.studioUploadRef(new File([blob], "ref.jpg", { type: "image/jpeg" }));
      props.onDraft((d) => ({ ...d, refs: d.refs.map((r) => (r.preview === preview ? { ...r, name } : r)) }));
    } catch (e) {
      props.onDraft((d) => ({ ...d, refs: d.refs.filter((r) => r.preview !== preview) }));
      props.onError(e instanceof Error ? e.message : "Upload ảnh thất bại");
    }
  };

  const addRefs = async (files: File[]) => {
    for (const f of files.filter((x) => x.type.startsWith("image/")).slice(0, MAX_REFS - draft.refs.length)) {
      try {
        await addRef(await refImage(f));
      } catch (e) {
        props.onError(e instanceof Error ? e.message : "Không đọc được ảnh");
      }
    }
  };

  const removeRef = (r: RefineRef) => {
    URL.revokeObjectURL(r.preview);
    props.onDraft((d) => ({ ...d, refs: d.refs.filter((x) => x.preview !== r.preview) }));
  };

  /** A clipart of the set as a reference (flattened on white like a photo); again = take it out. */
  const toggleClipartRef = async (a: CtAsset) => {
    const had = draft.refs.find((r) => r.clipart?.id === a.id);
    if (had) return removeRef(had);
    if (draft.refs.length >= MAX_REFS) return props.onError(`Tối đa ${MAX_REFS} ảnh mẫu`);
    try {
      const raw = await fetch(a.url).then((res) => res.blob());
      await addRef(await refImage(new File([raw], `${a.name}.png`, { type: raw.type || "image/png" })), { id: a.id, name: a.name });
    } catch (e) {
      props.onError(e instanceof Error ? e.message : "Không tải được clipart");
    }
  };

  /** Files, a clipart card from this dialog, or a clipart from the editor's library panel. */
  const onDropRefs = (e: React.DragEvent) => {
    const card = e.dataTransfer.getData(REF_DRAG);
    const lib = e.dataTransfer.getData(CLIPART_DRAG);
    if (card || lib) {
      try {
        const a: CtAsset = card ? (JSON.parse(card) as CtAsset) : (JSON.parse(lib) as CtClipartDrag).asset;
        if (!draft.refs.some((r) => r.clipart?.id === a.id)) void toggleClipartRef(a);
      } catch {
        props.onError("Không đọc được clipart kéo vào");
      }
      return;
    }
    void addRefs(Array.from(e.dataTransfer.files));
  };

  const analyze = async () => {
    if (!draft.fix.trim()) return props.onError("Ghi điều cần sửa");
    setAnalyzing(true);
    try {
      const s = await ctApi.suggestRefine({
        fix: draft.fix,
        images: await Promise.all(props.assets.slice(0, 12).map(async (a, i) => ({ image: await numberedImage(a.url, i + 1), name: a.name, spec: a.spec }))),
        refs: draft.refs.map((r) => r.blob),
        refNames: draft.refs.map((r) => r.clipart?.name ?? ""),
        category: category ? { name: category.name, usage: category.usage, mode: category.mode, spec: category.spec } : null,
        style: style ? { name: style.name, prompt: style.prompt } : null,
        updateSpec: draft.updateSpec && canSpec,
        updateStyle: draft.updateStyle && canStyle,
      });
      // The analysis answers per image in the order sent: back onto the asset ids.
      const own: Record<string, RefineOwn> = {};
      props.assets.slice(0, 12).forEach((a, i) => {
        const im = s.images[i];
        own[a.id] = { edit: im?.edit ?? "", spec: im?.spec ?? a.spec };
      });
      set({ plan: s, instruction: s.edit, own, keep: s.keep, spec: s.spec ?? "", styleText: s.style ?? "", saveSpec: s.spec !== null, saveStyle: s.style !== null });
    } catch (e) {
      props.onError(e instanceof Error ? e.message : "Phân tích thất bại");
    } finally {
      setAnalyzing(false);
    }
  };

  /** A past round back into the form (its instruction ready to apply again or tweak). */
  const reuse = (r: RefineRound) =>
    set({
      keep: r.keep,
      fix: r.fix,
      instruction: r.instruction,
      // Per-image fixes come back onto the selected images with the same name.
      own: Object.fromEntries(props.assets.map((a) => [a.id, { edit: r.own?.find((o) => o.name === a.name)?.edit ?? "", spec: a.spec }])),
      plan: { summary: "", keep: r.keep, edit: r.instruction, images: [], spec: null, style: null },
      model: r.model,
    });

  const uploading = draft.refs.some((r) => r.name === null);
  const n = props.assets.length;
  const plan = draft.plan;
  return (
    <div
      className={cx("space-y-3 rounded-md border border-sky-500/40 bg-sky-500/5 p-3", over && "border-sky-500")}
      onDragOver={(e) => {
        const t = e.dataTransfer.types;
        if (!t.includes("Files") && !t.includes(REF_DRAG) && !t.includes(CLIPART_DRAG)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onDropRefs(e);
      }}
    >
      <div className="flex items-center gap-2">
        <Wand2 className="h-3.5 w-3.5" />
        <span className="text-xs font-semibold">
          Chỉnh sửa {n}/{props.total} ảnh
        </span>
        <span className="text-[11px] text-muted-foreground">Bấm ảnh ở trên để chọn / bỏ. AI sửa trên chính ảnh đã tạo.</span>
        <button className="ml-auto rounded p-1 text-muted-foreground hover:bg-accent" onClick={props.onClose} aria-label="Đóng">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {props.history.length > 0 && (
        <div className="rounded-md border bg-background/60">
          <button className="flex w-full items-center gap-1 px-2 py-1.5 text-[11px] font-medium" onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Lịch sử chỉnh sửa ({props.history.length}) — đã yêu cầu gì, đã đổi spec / style ra sao
          </button>
          {showHistory && (
            <div className="max-h-72 space-y-2 overflow-y-auto border-t p-2">
              {props.history.map((r, i) => (
                <div key={r.at + i} className="space-y-1 rounded border p-2 text-[11px]">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <span>{new Date(r.at).toLocaleString("vi-VN")}</span>
                    <span>· {r.model}</span>
                    <span className="truncate">· {r.images.join(", ")}</span>
                    {r.refs > 0 && <span>· {r.refs} ảnh mẫu</span>}
                    <button className="ml-auto shrink-0 rounded border px-1.5 py-0.5 text-foreground hover:bg-accent" onClick={() => reuse(r)}>
                      Dùng lại
                    </button>
                  </div>
                  {r.keep && <p className="text-muted-foreground"><span className="font-medium text-foreground">Giữ:</span> {r.keep}</p>}
                  <p><span className="font-medium">Sửa:</span> {r.fix}</p>
                  <p className="text-muted-foreground"><span className="font-medium text-foreground">Lệnh chung:</span> {r.instruction || "—"}</p>
                  {r.own?.map((o) => (
                    <p key={o.name} className="text-muted-foreground"><span className="font-medium text-foreground">Riêng “{o.name}”:</span> {o.edit}</p>
                  ))}
                  {r.spec && (
                    <details>
                      <summary className="cursor-pointer font-medium text-sky-500">Spec chung đã cập nhật</summary>
                      <p className="mt-1 text-muted-foreground line-through decoration-rose-500/60">{r.spec.before || "(trống)"}</p>
                      <p className="mt-1">{r.spec.after}</p>
                    </details>
                  )}
                  {r.style && (
                    <details>
                      <summary className="cursor-pointer font-medium text-sky-500">Style pack “{r.style.name}” đã cập nhật</summary>
                      <p className="mt-1 text-muted-foreground line-through decoration-rose-500/60">{r.style.before}</p>
                      <p className="mt-1">{r.style.after}</p>
                    </details>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div>
        <CtField
          label="Cần sửa — gọi ảnh theo số #1, #2… trên thẻ"
          hint="Chỉ ghi điều cần đổi — phần nào, to / nhỏ bao nhiêu so với xe, kiểu gì, hướng nào. Mọi thứ không nhắc tới được giữ nguyên (AI tự liệt kê để bạn kiểm tra)."
        >
          <CtTextarea
            rows={3}
            value={draft.fix}
            onChange={(e) => set({ fix: e.target.value })}
            placeholder="vd. mũ bảo hiểm quá nhỏ — phải cao khoảng nửa thân xe, kiểu mũ phi công có kính như ảnh mẫu, hướng thẳng về người xem, có thân người mặc đồ đua bên dưới."
          />
        </CtField>
      </div>

      <div
        className={cx("space-y-2 rounded-md border border-dashed p-2", over && "border-sky-500 bg-sky-500/10")}
      >
        <div className="flex flex-wrap items-center gap-1.5">
          {draft.refs.map((r) => (
            <div key={r.preview} className="relative h-14 w-14 overflow-hidden rounded border" title={r.clipart ? `Clipart “${r.clipart.name}”` : "Ảnh mẫu"}>
              <img src={r.preview} alt="" className="h-full w-full object-cover" />
              {r.clipart && <span className="absolute inset-x-0 bottom-0 truncate bg-sky-600/90 px-0.5 text-center text-[9px] text-white">{r.clipart.name}</span>}
              {r.name === null ? (
                <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-white" />
                </div>
              ) : (
                <button className="absolute right-0.5 top-0.5 rounded bg-black/60 p-0.5 text-white" onClick={() => removeRef(r)} aria-label="Bỏ ảnh mẫu">
                  <X className="h-2.5 w-2.5" />
                </button>
              )}
            </div>
          ))}
          {draft.refs.length < MAX_REFS && (
            <button
              onClick={() => input.current?.click()}
              className="flex h-14 w-14 flex-col items-center justify-center gap-0.5 rounded border border-dashed text-[10px] leading-tight text-muted-foreground hover:bg-accent"
            >
              <ImagePlus className="h-4 w-4" /> ảnh mẫu
            </button>
          )}
          <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">
            Ảnh mẫu cho phần cần sửa — chọn file, <b>kéo thả</b> ảnh / thẻ clipart vào đây, hoặc chọn 1 clipart đã ưng ở dưới để các bản còn lại sửa theo. Tối đa {MAX_REFS}.
          </span>
          <input
            ref={input}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (files.length) void addRefs(files);
            }}
          />
        </div>
        {candidates.length > 0 && (
          <div className="space-y-1">
            <div className="text-[11px] font-medium text-muted-foreground">Dùng clipart cùng danh mục làm mẫu (bản đã đẹp → các bản khác sửa theo)</div>
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {candidates.map((a) => {
                const on = draft.refs.some((r) => r.clipart?.id === a.id);
                return (
                  <button
                    key={a.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "copy";
                      e.dataTransfer.setData(REF_DRAG, JSON.stringify(a));
                    }}
                    onClick={() => void toggleClipartRef(a)}
                    disabled={!on && draft.refs.length >= MAX_REFS}
                    title={on ? `Bỏ “${a.name}” khỏi ảnh mẫu` : `Dùng “${a.name}” làm ảnh mẫu`}
                    className={cx("relative w-16 shrink-0 overflow-hidden rounded border text-left disabled:opacity-40", on && "border-sky-500 ring-1 ring-sky-500")}
                  >
                    <div className="aspect-square" style={CHECKER_STYLE}>
                      <img src={a.url} alt="" className="h-full w-full object-contain" loading="lazy" />
                    </div>
                    <div className="truncate px-0.5 text-[9px]">{a.name}</div>
                    {on && (
                      <span className="absolute right-0.5 top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded bg-sky-500 text-white">
                        <Check className="h-2.5 w-2.5" />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <CtCheckbox
          checked={draft.updateSpec && canSpec}
          onChange={(updateSpec) => set({ updateSpec })}
          label={`Cập nhật Spec chung${category ? ` “${category.name}”` : ""} nếu cần`}
          hint={
            canSpec
              ? "Yêu cầu áp cho cả bộ (cỡ / kiểu mũ, góc nhìn…) → ghi vào spec, các clipart tạo sau cũng đúng. AI tự bỏ qua nếu chỉ là sửa riêng."
              : "Không sửa được: các ảnh thuộc nhiều danh mục, hoặc không có quyền sửa danh mục."
          }
        />
        <CtCheckbox
          checked={draft.updateStyle && canStyle}
          onChange={(updateStyle) => set({ updateStyle })}
          label={`Cập nhật Style pack${style ? ` “${style.name}”` : ""} nếu cần`}
          hint={canStyle ? "Chỉ khi yêu cầu là về cách vẽ (nét, đổ bóng, độ bóng, màu). Đổi style pack ảnh hưởng mọi danh mục dùng nó." : "Không có style pack sửa được."}
        />
      </div>

      <div className="flex justify-end">
        <CtButton size="sm" onClick={() => void analyze()} disabled={analyzing || !draft.fix.trim() || uploading || n === 0}>
          {analyzing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} {plan ? "Phân tích lại" : "Phân tích yêu cầu"}
        </CtButton>
      </div>

      {plan && (
        <div className="space-y-3 border-t pt-3">
          {plan.summary && <p className="rounded-md bg-background/60 p-2 text-xs">{plan.summary}</p>}
          <CtField
            label="Lệnh chung cho cả bộ"
            hint="Gửi y hệt cho MỌI ảnh — viết dạng trạng thái cuối cùng (ảnh đã đúng thì giữ nguyên). Đừng nhắc tên 1 ảnh ở đây: thay đổi riêng ghi vào ô của ảnh đó bên dưới."
          >
            <CtTextarea rows={4} value={draft.instruction} onChange={(e) => set({ instruction: e.target.value })} />
          </CtField>
          <div className="space-y-1.5">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Từng ảnh — sửa riêng + mô tả riêng</div>
            {props.assets.map((a, i) => {
              const o = draft.own[a.id] ?? { edit: "", spec: a.spec };
              const setOwn = (patch: Partial<RefineOwn>) => props.onDraft((d) => ({ ...d, own: { ...d.own, [a.id]: { ...o, ...(d.own[a.id] ?? {}), ...patch } } }));
              return (
                <div key={a.id} className="grid grid-cols-[56px_1fr] gap-2 rounded-md border bg-background/60 p-2">
                  <div className="h-14 w-14 overflow-hidden rounded border" style={CHECKER_STYLE}>
                    <img src={a.url} alt="" className="h-full w-full object-contain" />
                  </div>
                  <div className="space-y-1">
                    <div className="text-[11px] font-medium">
                      <span className="mr-1 rounded-full bg-foreground px-1.5 text-[10px] font-bold text-background">#{i + 1}</span>
                      {a.name}
                    </div>
                    <CtTextarea rows={2} value={o.edit} placeholder="Sửa riêng ảnh này (trống = chỉ áp lệnh chung)" onChange={(e) => setOwn({ edit: e.target.value })} />
                    <CtTextarea rows={2} value={o.spec} placeholder="Mô tả riêng (model, màu, chi tiết nhận diện) — lưu vào spec của clipart" onChange={(e) => setOwn({ spec: e.target.value })} />
                  </div>
                </div>
              );
            })}
          </div>
          <CtField label="AI sẽ giữ nguyên" hint="Mọi thứ bạn không nhắc tới — gửi kèm cho model như phần BẮT BUỘC giữ y hệt. Thiếu gì thì thêm vào.">
            <CtTextarea rows={3} value={draft.keep} onChange={(e) => set({ keep: e.target.value })} />
          </CtField>
          {plan.spec !== null && (
            <div className="space-y-1.5">
              <CtCheckbox checked={draft.saveSpec} onChange={(saveSpec) => set({ saveSpec })} label="Lưu Spec chung mới vào danh mục" />
              <CtTextarea rows={4} value={draft.spec} onChange={(e) => set({ spec: e.target.value })} disabled={!draft.saveSpec} />
              <SentenceDiff before={category?.spec ?? ""} after={draft.spec} />
            </div>
          )}
          {plan.style !== null && (
            <div className="space-y-1.5">
              <CtCheckbox checked={draft.saveStyle} onChange={(saveStyle) => set({ saveStyle })} label={`Lưu prompt mới vào style pack “${style?.name ?? ""}”`} />
              <CtTextarea rows={4} value={draft.styleText} onChange={(e) => set({ styleText: e.target.value })} disabled={!draft.saveStyle} />
              <SentenceDiff before={style?.prompt ?? ""} after={draft.styleText} />
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-[minmax(0,260px)_1fr] sm:items-end">
            <div className="space-y-2">
              <p className="text-[11px] leading-snug text-muted-foreground">Sửa trên bản phẳng. Vật liệu làm lại ở bước 3 khi ảnh đã ưng.</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {/* Always on: the edited version takes the old one's place in every product using it. */}
              <CtButton
                variant="primary"
                className="ml-auto"
                disabled={props.busy || (!draft.instruction.trim() && !props.assets.some((a) => draft.own[a.id]?.edit.trim())) || uploading || n === 0 || !model}
                onClick={() =>
                  props.onApply({
                    instruction: draft.instruction.trim(),
                    own: Object.fromEntries(
                      props.assets.map((a) => [a.id, { edit: draft.own[a.id]?.edit.trim() ?? "", spec: (draft.own[a.id]?.spec ?? a.spec).trim() }]),
                    ),
                    keep: draft.keep.trim(),
                    refs: draft.refs.map((r) => r.name).filter((x): x is string => x !== null),
                    spec: plan.spec !== null && draft.saveSpec && draft.spec.trim() ? draft.spec.trim() : null,
                    style: plan.style !== null && draft.saveStyle && draft.styleText.trim() ? draft.styleText.trim() : null,
                    replace: draft.replace,
                    model,
                  })
                }
              >
                {props.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />} Áp dụng & sửa {n} ảnh
              </CtButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The category panel (what every tab applies without being asked)
// ---------------------------------------------------------------------------

/**
 * The dialog's category, the same on every tab: spec chung → style pack → vật liệu → chi tiết thành phẩm, in the
 * order they are used. One edit button opens the category dialog. Folds to a strip for a wider form.
 */
function CategoryPanel({
  category,
  style,
  materials,
  open,
  onToggle,
  onEdit,
}: {
  category: CtClipartCategory | null;
  style: CtPreset | null;
  materials: CtPreset[];
  open: boolean;
  onToggle: () => void;
  onEdit: (c: CtClipartCategory) => void;
}) {
  if (!open) {
    return (
      <aside className="flex h-fit flex-col items-center gap-2 rounded-lg border bg-muted/30 py-2">
        <CtTooltip label="Mở thông tin danh mục">
          <button className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={onToggle}>
            <PanelRightOpen className="h-4 w-4" />
          </button>
        </CtTooltip>
        {category && <span className="text-[11px] font-medium text-muted-foreground [writing-mode:vertical-rl]">{category.name}</span>}
      </aside>
    );
  }
  const details = category?.rules.details ?? [];
  const extra = details.filter((d) => d.mode === "version");
  return (
    <aside className="h-fit max-h-[70vh] space-y-3 overflow-y-auto rounded-lg border bg-muted/30 p-3 text-[11px]">
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{category ? category.name : "Chưa chọn danh mục"}</span>
        {category?.can_edit !== false && category && (
          <CtButton size="sm" onClick={() => onEdit(category)}>
            <Pencil className="h-3 w-3" /> Sửa
          </CtButton>
        )}
        <CtTooltip label="Thu nhỏ — form rộng hơn">
          <button className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={onToggle}>
            <PanelRightClose className="h-4 w-4" />
          </button>
        </CtTooltip>
      </div>
      {category ? (
        <>
          <p className="-mt-2 text-muted-foreground">
            {category.rules.canvas.w}×{category.rules.canvas.h}px
          </p>
          <Block title="Spec chung">
            {category.spec ? <p className="line-clamp-5 leading-snug text-muted-foreground">{category.spec}</p> : <p className="text-amber-500">Chưa có spec chung.</p>}
          </Block>
          <Block title="Style pack">
            {style ? (
              <>
                <div className="font-medium">{style.name}</div>
                <p className="line-clamp-4 leading-snug text-muted-foreground">{style.prompt}</p>
              </>
            ) : (
              <span className="text-amber-500">Chưa có style pack.</span>
            )}
          </Block>
          <Block title="Vật liệu">
            {materials.length ? (
              <div className="flex flex-wrap gap-1">
                {materials.map((m) => (
                  <span key={m.id} className="rounded-full border border-violet-500/40 bg-violet-500/10 px-1.5 py-px text-violet-700 dark:text-violet-300">
                    {m.name}
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-muted-foreground">Chưa gắn vật liệu — chỉ có clipart phẳng.</span>
            )}
          </Block>
          <Block title={`Chi tiết thành phẩm (${details.length})`}>
            {details.length ? (
              <ul className="space-y-1">
                {details.map((d, i) => (
                  <li key={i} className="flex gap-1.5 leading-snug">
                    <span className={cx("h-fit shrink-0 rounded px-1 text-[10px]", d.mode === "version" ? "bg-violet-500/15 text-violet-600" : "bg-muted text-muted-foreground")}>
                      {d.mode === "version" ? d.label : "luôn có"}
                    </span>
                    <span className="line-clamp-2 text-muted-foreground">{d.text}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-muted-foreground">Chưa có.</span>
            )}
            {materials.length > 0 && (
              <p className="pt-1 leading-snug text-muted-foreground">
                Mỗi clipart gốc ở bước 3: <b className="text-foreground">{1 + extra.length} ảnh / vật liệu</b> (bản chính{extra.map((d) => ` + “${d.label}”`).join("")}).
              </p>
            )}
          </Block>
        </>
      ) : (
        <p className="text-muted-foreground">Chọn danh mục bên trái để xem spec chung, style pack, vật liệu và chi tiết thành phẩm.</p>
      )}
    </aside>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5 border-t pt-2">
      <div className="font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}

function RunProgress({ run }: { run: RunState }) {
  const [now, setNow] = useState(run.startedAt);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = run.status;
  const what = s.status === "queued" ? `Đang xếp hàng${s.position ? ` (#${s.position})` : ""}` : s.node ? (NODE_LABEL[s.node] ?? s.node) : "Đang chạy";
  return (
    <div className="flex items-center gap-2 rounded-md border bg-sky-500/5 px-3 py-2 text-xs">
      <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-500" />
      <span>{what}…</span>
      <span className="text-muted-foreground">{Math.max(0, Math.round((now - run.startedAt) / 1000))}s</span>
      <span className="ml-auto text-[11px] text-muted-foreground">Đóng dialog vẫn chạy tiếp — kết quả tự vào thư viện.</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recipe forms
// ---------------------------------------------------------------------------

function OriginFields({
  form,
  onError,
  setSubjects,
}: {
  form: OriginForm;
  setSubjects: (fn: (list: Subject[]) => Subject[]) => void;
  onError: (msg: string) => void;
}) {
  // Functional: uploads finish after later edits.
  const patch = (key: number, fn: (s: Subject) => Subject) => setSubjects((list) => list.map((s) => (s.key === key ? fn(s) : s)));

  const addRefs = async (key: number, files: File[]) => {
    for (const file of files.filter((f) => /^image\//.test(f.type)).slice(0, 4)) {
      const preview = URL.createObjectURL(file);
      patch(key, (s) => ({ ...s, refs: [...s.refs, { name: null, preview }] }));
      try {
        const name = await ctApi.studioUploadRef(file);
        patch(key, (s) => ({ ...s, refs: s.refs.map((r) => (r.preview === preview ? { ...r, name } : r)) }));
      } catch (e) {
        patch(key, (s) => ({ ...s, refs: s.refs.filter((r) => r.preview !== preview) }));
        onError(e instanceof Error ? e.message : "Upload ảnh thất bại");
      }
    }
  };

  const many = form.subjects.length > 1;
  return (
    <>
      <CtField
        label={many ? `Clipart cần tạo (${form.subjects.length} hình, cùng 1 bộ)` : "Clipart cần tạo"}
        hint="Danh mục đã lo phần chung (spec chung, style pack). Ở đây chỉ cần nói hình NÀY là gì — hoặc kéo ảnh tham khảo vào (xe, xửng, ly chè…). Cùng 1 hình nhiều màu → tạo 1 hình rồi sang bước Đa sắc."
      >
        <div className="space-y-2">
          {form.subjects.map((s, i) => (
            <SubjectCard
              key={s.key}
              subject={s}
              index={i}
              removable={many}
              onChange={(p) => patch(s.key, (x) => ({ ...x, ...p }))}
              onRemove={() => setSubjects((list) => list.filter((x) => x.key !== s.key))}
              onFiles={(files) => void addRefs(s.key, files)}
            />
          ))}
          <CtButton size="sm" onClick={() => setSubjects((list) => [...list, newSubject()])}>
            <Plus className="h-3.5 w-3.5" /> Thêm hình khác cùng bộ
          </CtButton>
        </div>
      </CtField>
      <p className="rounded-md border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-[11px] leading-snug text-muted-foreground">
        Bước này <b className="text-foreground">chỉ vẽ clipart gốc</b> (phẳng). Vật liệu và chi tiết thành phẩm chưa được tạo — clipart gốc thường phải tạo / sửa nhiều lượt, làm vật liệu cho mọi lượt là tốn tiền. Khi
        clipart gốc đã ưng, bấm <b className="text-foreground">Vật liệu →</b> trên kết quả.
      </p>
    </>
  );
}

/** Placeholder pairs: the description example always matches the name example above it. */
const SUBJECT_EXAMPLES: Array<{ name: string; text: string }> = [
  { name: "sedan", text: "xe sedan 4 cửa màu đỏ, mâm bạc, kính đen" },
  { name: "pickup", text: "xe bán tải màu xanh navy, thùng sau trống, lốp to" },
  { name: "SUV", text: "xe SUV màu trắng, giá nóc, đèn tròn" },
];

function SubjectCard({
  subject,
  index,
  removable,
  onChange,
  onRemove,
  onFiles,
}: {
  subject: Subject;
  index: number;
  removable: boolean;
  onChange: (p: Partial<Subject>) => void;
  onRemove: () => void;
  onFiles: (files: File[]) => void;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const [over, setOver] = useState(false);
  const example = SUBJECT_EXAMPLES[index % SUBJECT_EXAMPLES.length];
  return (
    <div
      className={cx("flex gap-2 rounded-md border p-2", over && "border-sky-500 bg-sky-500/5")}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <div className="flex w-[132px] shrink-0 flex-wrap content-start gap-1">
        {subject.refs.map((r) => (
          <div key={r.preview} className="relative h-[62px] w-[62px] overflow-hidden rounded border" style={CHECKER_STYLE}>
            <img src={r.preview} alt="" className={cx("h-full w-full object-cover", r.name === null && "opacity-40")} />
            {r.name === null ? (
              <Loader2 className="absolute inset-0 m-auto h-4 w-4 animate-spin" />
            ) : (
              <button className="absolute right-0.5 top-0.5 rounded bg-black/60 p-0.5 text-white" onClick={() => onChange({ refs: subject.refs.filter((x) => x.preview !== r.preview) })}>
                <X className="h-2.5 w-2.5" />
              </button>
            )}
          </div>
        ))}
        {subject.refs.length < 4 && (
          <button
            onClick={() => input.current?.click()}
            className="flex h-[62px] w-[62px] flex-col items-center justify-center gap-0.5 rounded border border-dashed text-[10px] leading-tight text-muted-foreground hover:bg-accent"
          >
            <ImagePlus className="h-4 w-4" /> ảnh tham khảo
          </button>
        )}
        <input
          ref={input}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length) onFiles(files);
          }}
        />
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex gap-1.5">
          <CtInput className="h-8" placeholder={`Tên (vd. ${example.name})`} value={subject.name} onChange={(e) => onChange({ name: e.target.value })} />
          {removable && (
            <button className="rounded p-1.5 text-muted-foreground hover:bg-accent" onClick={onRemove} title="Bỏ hình này">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <CtTextarea
          rows={2}
          placeholder={
            subject.refs.length
              ? "Để trống = vẽ theo ảnh tham khảo. Hoặc ghi điểm cần đổi / nhấn mạnh."
              : `Mô tả ${subject.name.trim() || example.name}: màu, dáng, chi tiết nổi bật — vd. ${example.text}. Hoặc kéo ảnh tham khảo vào khung.`
          }
          value={subject.text}
          onChange={(e) => onChange({ text: e.target.value })}
        />
      </div>
    </div>
  );
}

/** Biến thể / Vật liệu: the category's origins — tick as many as the run should take, straight in the grid. */
/** What the Đa sắc / Vật liệu steps start from: the gốc — for Đa sắc also their vật liệu versions. */
function sources(list: CtAsset[], withMaterials: boolean): CtAsset[] {
  const origins = libraryOrigins(list);
  if (!withMaterials) return origins;
  return origins.flatMap((o) => [o, ...list.filter((a) => a.parent_id === o.id && isMaterialClipart(a) && !isMulticolorClipart(a))]);
}

function OriginGrid({
  clips,
  fixedId,
  library,
  withMaterials,
  onToggle,
  onAll,
}: {
  clips: CtAsset[];
  /** The clipart the dialog was opened on — it stays ticked. */
  fixedId: string | null;
  /** The category's cliparts (null while loading). */
  library: CtAsset[] | null;
  /** Đa sắc step: vật liệu versions can be the source too. */
  withMaterials: boolean;
  onToggle: (a: CtAsset) => void;
  onAll: (on: boolean) => void;
}) {
  const [q, setQ] = useState("");
  const chosen = new Set(clips.map((c) => c.id));
  const all = sources(library ?? [], withMaterials);
  // The dialog's clipart shows even before the listing arrives (or when it is outside the category).
  const list = [...clips.filter((c) => !all.some((o) => o.id === c.id)), ...all];
  const shown = list.filter((o) => !q.trim() || o.name.toLowerCase().includes(q.trim().toLowerCase()));
  const free = all.filter((o) => o.id !== fixedId);
  const allOn = free.length > 0 && free.every((o) => chosen.has(o.id));
  return (
    <CtField
      label={`${withMaterials ? "Clipart gốc / bản vật liệu" : "Clipart gốc"} — đã chọn ${clips.length}/${list.length}`}
      hint={withMaterials ? "Bấm để chọn / bỏ — đa sắc của bản vật liệu cũng là 1 bản vật liệu (badge đa sắc + vật liệu)." : "Bấm để chọn / bỏ — chọn nhiều clipart gốc để làm 1 lượt."}
    >
      <div className="space-y-2 rounded-md border p-2">
        <div className="flex gap-1.5">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2 top-2 h-4 w-4 text-muted-foreground" />
            <CtInput className="h-8 pl-7" placeholder="Tìm clipart…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {free.length > 1 && (
            <CtButton size="sm" variant="ghost" onClick={() => onAll(!allOn)}>
              {allOn ? "Bỏ chọn hết" : "Chọn tất cả"}
            </CtButton>
          )}
        </div>
        {library === null && list.length === 0 ? (
          <div className="flex justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : (
          // p-1: the scroll box clips its children at the edge — room for the selected ring.
          <div className="grid max-h-64 grid-cols-4 gap-1.5 overflow-y-auto p-1 sm:grid-cols-6">
            {shown.map((o) => {
              const on = chosen.has(o.id);
              return (
                <button
                  key={o.id}
                  onClick={() => onToggle(o)}
                  disabled={o.id === fixedId}
                  title={on ? `Bỏ ${o.name}` : o.name}
                  className={cx("relative space-y-0.5 rounded border p-0.5 transition-opacity", on ? "border-sky-500 ring-1 ring-sky-500" : "opacity-70 hover:border-sky-500 hover:opacity-100")}
                >
                  <div className="relative aspect-square overflow-hidden rounded" style={CHECKER_STYLE}>
                    <img src={o.url} alt={o.name} className="h-full w-full object-contain" loading="lazy" />
                    <ClipartBadges asset={o} className="absolute inset-x-0.5 bottom-0.5" />
                  </div>
                  <div className="truncate text-[10px]">{o.name}</div>
                  <span
                    className={cx(
                      "absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded border",
                      on ? "border-sky-500 bg-sky-500 text-white" : "border-white/70 bg-black/40",
                    )}
                  >
                    {on && <Check className="h-3 w-3" />}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </CtField>
  );
}

const MAX_LINE_PICS = 3;

function VariantFields({
  form,
  set,
  patchPics,
  onError,
  members,
}: {
  form: VariantForm;
  set: (p: Partial<VariantForm>) => void;
  /** Every line's photos at once (an upload finishes after later edits — matched by preview). */
  patchPics: (fn: (pics: RefImage[]) => RefImage[]) => void;
  onError: (msg: string) => void;
  members: CtAsset[];
}) {
  const setLine = (i: number, patch: Partial<VariantLine>) => set({ lines: form.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const picsFor = useRef<number | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  /** Photos of the look an AI line asks for ("glitter like this"): uploaded to the studio, sent with the clipart. */
  const addPics = async (i: number, files: File[]) => {
    const room = MAX_LINE_PICS - (form.lines[i]?.pics?.length ?? 0);
    const list = files.filter((f) => f.type.startsWith("image/")).slice(0, Math.max(0, room));
    const added = list.map((file) => ({ file, preview: URL.createObjectURL(file) }));
    if (!added.length) return;
    setLine(i, { pics: [...(form.lines[i]?.pics ?? []), ...added.map((a) => ({ name: null, preview: a.preview }))] });
    for (const a of added) {
      try {
        const name = await ctApi.studioUploadRef(a.file);
        patchPics((pics) => pics.map((r) => (r.preview === a.preview ? { ...r, name } : r)));
      } catch (e) {
        patchPics((pics) => pics.filter((r) => r.preview !== a.preview));
        onError(e instanceof Error ? e.message : "Upload ảnh thất bại");
      }
    }
  };
  const have = new Set(members.map((m) => m.name.toLowerCase()));
  const recolors = form.lines.filter((l) => l.mode === "recolor" && l.text.trim()).length;
  const ai = form.lines.filter((l) => l.mode === "ai" && l.text.trim()).length;
  return (
    <>
      {members.length > 0 && (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          Đã có {members.length} đa sắc:
          <div className="flex -space-x-2">
            {members.slice(0, 10).map((m) => (
              <img key={m.id} src={m.url} alt={m.name} title={m.name} className="h-7 w-7 rounded-full border bg-background object-contain" />
            ))}
          </div>
        </div>
      )}

      <CtField
        label={`Đa sắc cần tạo (${recolors} đổi màu · ${ai} AI)`}
        hint="Màu: recolor từng pixel — không gọi AI, miễn phí, giữ 100% hình. AI: mô tả thay đổi (glitter, hoạ tiết…) → AI sửa rồi ép lại đúng silhouette gốc."
      >
        <div className="space-y-1.5">
          {form.lines.length === 0 && <p className="rounded-md border border-dashed px-3 py-3 text-center text-xs text-muted-foreground">Bấm “Thêm màu”, “Thêm style AI” hoặc “Bảng màu chuẩn” bên dưới.</p>}
          {form.lines.map((l, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <CtInput className="w-28 shrink-0" placeholder="tên" value={l.name} onChange={(e) => setLine(i, { name: e.target.value })} />
              <div className="flex shrink-0 rounded-md border p-0.5">
                {(["recolor", "ai"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setLine(i, { mode: m, text: m === "recolor" ? (HEX.test(l.text) ? l.text : "#f7a8d8") : HEX.test(l.text) ? "" : l.text })}
                    className={cx("flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]", l.mode === m ? "bg-foreground text-background" : "text-muted-foreground hover:bg-accent")}
                  >
                    {m === "recolor" ? <Palette className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />}
                    {m === "recolor" ? "Màu" : "AI"}
                  </button>
                ))}
              </div>
              {l.mode === "recolor" ? (
                <>
                  <input
                    type="color"
                    className="h-8 w-10 shrink-0 cursor-pointer rounded border bg-transparent p-0.5"
                    value={HEX.test(l.text) ? l.text : "#cccccc"}
                    onChange={(e) => setLine(i, { text: e.target.value })}
                  />
                  <CtInput className="w-24" value={l.text} onChange={(e) => setLine(i, { text: e.target.value })} />
                </>
              ) : (
                <>
                  <CtInput placeholder="vd. rainbow holographic glitter body" value={l.text} onChange={(e) => setLine(i, { text: e.target.value })} />
                  {(l.pics ?? []).map((r) => (
                    <div key={r.preview} className="relative h-8 w-8 shrink-0 overflow-hidden rounded border" style={CHECKER_STYLE}>
                      <img src={r.preview} alt="" className={cx("h-full w-full object-cover", r.name === null && "opacity-40")} />
                      {r.name === null ? (
                        <Loader2 className="absolute inset-0 m-auto h-3 w-3 animate-spin" />
                      ) : (
                        <button
                          className="absolute right-0 top-0 rounded-bl bg-black/60 p-px text-white"
                          onClick={() => setLine(i, { pics: (l.pics ?? []).filter((x) => x.preview !== r.preview) })}
                          title="Bỏ ảnh"
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                      )}
                    </div>
                  ))}
                  {(l.pics?.length ?? 0) < MAX_LINE_PICS && (
                    <CtTooltip label="Ảnh mẫu của kiểu muốn có (vd. ảnh glitter, hoạ tiết) — AI nhận cùng clipart, chỉ học vẻ ngoài, không chép hình">
                      <button
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-dashed text-muted-foreground hover:bg-accent"
                        onClick={() => {
                          picsFor.current = i;
                          picker.current?.click();
                        }}
                      >
                        <ImagePlus className="h-3.5 w-3.5" />
                      </button>
                    </CtTooltip>
                  )}
                </>
              )}
              {have.has(l.name.trim().toLowerCase()) && <span className="shrink-0 text-[10px] text-amber-500">trùng tên</span>}
              <button className="ml-auto rounded p-1.5 text-muted-foreground hover:bg-accent" onClick={() => set({ lines: form.lines.filter((_, j) => j !== i) })}>
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <input
            ref={picker}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (files.length && picsFor.current !== null) void addPics(picsFor.current, files);
            }}
          />
          <div className="flex flex-wrap gap-1.5">
            <CtButton size="sm" onClick={() => set({ lines: [...form.lines, { name: "", text: "#f7a8d8", mode: "recolor" }] })}>
              <Palette className="h-3.5 w-3.5" /> Thêm màu
            </CtButton>
            <CtButton size="sm" onClick={() => set({ lines: [...form.lines, { name: "", text: "", mode: "ai" }] })}>
              <Sparkles className="h-3.5 w-3.5" /> Thêm style AI
            </CtButton>
            <CtButton size="sm" variant="ghost" onClick={() => set({ lines: [...form.lines, ...STANDARD_PALETTE.filter((p) => !have.has(p.name) && !form.lines.some((l) => l.name === p.name))] })}>
              + Bảng màu chuẩn ({STANDARD_PALETTE.length})
            </CtButton>
          </div>
        </div>
      </CtField>

    </>
  );
}

/**
 * Step 3: theo alpha (the clipart's own outline — acrylic cut to shape) or theo khuôn of a product (a round
 * ornament, trousers: the clipart cut to that product's khuôn vật liệu, all the same size). Only products where
 * the gốc is a version with a khuôn are listed.
 */
function FrameFields({
  value,
  onChange,
  products,
  loading,
}: {
  value: string | null;
  onChange: (productId: string | null) => void;
  products: Array<{ frame: CtClipartFrame; missing: CtAsset[] }>;
  loading: boolean;
}) {
  if (!products.length && !value)
    return (
      <p className="text-[11px] text-muted-foreground">
        {loading
          ? "Đang tìm khuôn sản phẩm…"
          : "Vật liệu theo alpha (viền của clipart). Sản phẩm hình cố định (ornament tròn, cái quần…): đưa clipart vào 1 sản phẩm, vẽ “Khuôn vật liệu” (phím K) — khuôn hiện ở đây."}
      </p>
    );
  const tile = (on: boolean) => cx("flex w-28 flex-col items-center gap-1 rounded-md border-2 p-1.5 text-center text-[11px]", on ? "border-sky-500 bg-sky-500/5" : "border-transparent hover:border-muted-foreground/30");
  return (
    <CtField label="Hình dạng vật liệu" hint="Theo khuôn: clipart cắt theo khuôn của sản phẩm (cả vùng cắt bỏ / lỗ đục) rồi mới làm vật liệu — giữ y nguyên viền, mọi clipart ra cùng kích thước 100%.">
      <div className="flex flex-wrap gap-1.5">
        <button className={tile(value === null)} onClick={() => onChange(null)}>
          <div className="flex h-14 w-14 items-center justify-center rounded border border-dashed text-[10px] text-muted-foreground">alpha</div>
          <span className="leading-tight">Theo alpha (viền clipart)</span>
        </button>
        {products.map(({ frame: f, missing }) => (
          <button key={f.productId} className={tile(value === f.productId)} onClick={() => onChange(f.productId)} title={missing.length ? `Chưa có khuôn cho: ${missing.map((c) => c.name).join(", ")}` : undefined}>
            <svg viewBox={`-0.05 -0.05 ${f.box.w / Math.max(f.box.w, f.box.h) + 0.1} ${f.box.h / Math.max(f.box.w, f.box.h) + 0.1}`} className="h-14 w-14">
              <path
                d={`M${f.outline.map(([x, y]) => `${(x * f.box.w) / Math.max(f.box.w, f.box.h)},${(y * f.box.h) / Math.max(f.box.w, f.box.h)}`).join("L")}Z`}
                fill="rgba(245,158,11,0.15)"
                stroke="#f59e0b"
                strokeWidth={0.03}
              />
            </svg>
            <span className="line-clamp-2 leading-tight">Khuôn: {f.productName}</span>
            {missing.length > 0 && <span className="text-[10px] text-amber-600">thiếu {missing.length} clipart</span>}
          </button>
        ))}
      </div>
    </CtField>
  );
}

function MaterialFields({
  form,
  set,
  materials,
  categoryMaterials,
  details,
  groups,
}: {
  form: MaterialForm;
  set: (p: Partial<MaterialForm>) => void;
  materials: CtPreset[];
  /** The category's materials — listed first. */
  categoryMaterials: CtPreset[];
  /** The category's product details: each "extra version" one is one more image per clipart. */
  details: CtMaterialSpec[];
  /** One per chosen origin: it and its set members. */
  groups: Array<{ origin: CtAsset; items: CtAsset[] }>;
}) {
  const members = groups.flatMap((g) => g.items.filter((a) => a.id !== g.origin.id));
  const chosenMembers = members.filter((a) => form.targetIds.includes(a.id)).length;
  const images = groups.length + chosenMembers;
  const toggle = (id: string) => set({ targetIds: form.targetIds.includes(id) ? form.targetIds.filter((x) => x !== id) : [...form.targetIds, id] });
  const own = new Set(categoryMaterials.map((m) => m.id));
  const options = [
    ...categoryMaterials.map((m) => ({ value: m.id, label: m.name })),
    ...materials.filter((m) => !own.has(m.id)).map((m) => ({ value: m.id, label: `${m.name} (ngoài danh mục)` })),
  ];
  const extra = details.filter((d) => d.mode === "version");
  const perClip = 1 + extra.length;
  return (
    <>
      <CtField label="Vật liệu" hint="Vật liệu của danh mục đứng đầu. Thêm / sửa vật liệu: nút Sửa ở bảng danh mục.">
        <CtSelect<string> value={form.materialId} onChange={(materialId) => set({ materialId })} options={options.length ? options : [{ value: "", label: "— Chưa có vật liệu —" }]} />
      </CtField>
      {members.length > 0 && (
        <CtField label={`Làm vật liệu cho cả đa sắc? (${chosenMembers}/${members.length})`} hint="Clipart gốc đã chọn ở trên luôn được làm. Bấm đa sắc nào thì đa sắc đó cũng được làm.">
          <div className="space-y-2 rounded-md border p-2">
            {groups
              .filter((g) => g.items.some((a) => a.id !== g.origin.id))
              .map((g) => (
                <div key={g.origin.id} className="flex items-center gap-2">
                  <div className="flex w-32 shrink-0 items-center gap-1.5">
                    <div className="h-9 w-9 shrink-0 overflow-hidden rounded border border-sky-500" style={CHECKER_STYLE}>
                      <img src={g.origin.url} alt={g.origin.name} className="h-full w-full object-contain" />
                    </div>
                    <span className="truncate text-[11px] font-medium">{g.origin.name}</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {g.items
                      .filter((a) => a.id !== g.origin.id)
                      .map((a) => {
                        const on = form.targetIds.includes(a.id);
                        return (
                          <button
                            key={a.id}
                            onClick={() => toggle(a.id)}
                            title={a.name}
                            className={cx("relative h-11 w-11 overflow-hidden rounded border-2", on ? "border-sky-500" : "border-transparent opacity-50 hover:opacity-100")}
                            style={CHECKER_STYLE}
                          >
                            <img src={a.url} alt={a.name} className="h-full w-full object-contain" />
                          </button>
                        );
                      })}
                  </div>
                </div>
              ))}
            <CtButton size="sm" variant="ghost" onClick={() => set({ targetIds: chosenMembers === members.length ? [] : members.map((a) => a.id) })}>
              {chosenMembers === members.length ? "Bỏ hết đa sắc" : "Chọn tất cả đa sắc"}
            </CtButton>
          </div>
        </CtField>
      )}
      <p className="rounded-md border border-violet-500/30 bg-violet-500/5 px-3 py-2 text-[11px] leading-snug text-muted-foreground">
        Mỗi ảnh chọn → <b className="text-foreground">{perClip} ảnh</b>: vật liệu + chi tiết thành phẩm luôn có
        {extra.map((d) => ` · bản thêm “${d.label}”`).join("")}. Tổng {images} ảnh × {perClip} = {images * perClip} lượt AI.
      </p>
    </>
  );
}
