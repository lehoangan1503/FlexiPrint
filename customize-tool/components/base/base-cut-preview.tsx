"use client";

/**
 * Two parts of a product base page (2026-11-08: the base owns the physical piece, the artwork only the design):
 *
 *   Cắt + file in        fixed khuôn / along the art (+ border mm) / flat — the print file always has its silhouette
 *   Phôi / nền xem trước the photo the preview is drawn on: a phôi trơn (the sheet's box on it), or — cut along the
 *                        art — a background the clear plate made from the design is laid on. Below it the AI
 *                        backgrounds (2026-11-12): 3 templates or the editor's words, the AI reads the base's info to
 *                        put the blank piece in its real place (server/base-scenes.ts); pick one = the preview.
 *
 * Every artwork viewed on the base and every product made on it read these (lib/base-fit).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, ImageIcon, Loader2, RefreshCw, Sparkles, Store, Trash2, Upload, X } from "lucide-react";
import type { CtAgentTask, CtBasePreviewResult, CtBaseScene, CtBaseScenePreset, CtBaseScenesAuto, CtBaseStoreState, CtBaseCut, CtBaseCutMode, CtBaseProductConfig, CtProductScene, CtSideLoss } from "../../types";
import { defaultCategoryRules } from "../../lib/library";
import type { CtPrintTemplate } from "../../types/print";
import { printApi } from "../../lib/print-api";
import { ctApi } from "../../lib/api-client";
import { defaultScene } from "../../lib/scene";
import { CHECKER_STYLE, CtButton, CtField, CtInput, CtSelect, CtTextarea } from "../ui";

const MODES: Array<{ value: CtBaseCutMode; label: string }> = [
  { value: "khuon", label: "Theo khuôn in (nét liền = cắt, nét đứt = vùng an toàn)" },
  { value: "alpha", label: "Cắt theo viền thiết kế (acrylic)" },
  { value: "none", label: "In phẳng nguyên canvas (không khuôn)" },
];

export function BaseCutSection(props: { cfg: CtBaseProductConfig; template: CtPrintTemplate | null; onChange: (cut: CtBaseCut) => void }) {
  const { cut } = props.cfg;
  const set = (p: Partial<CtBaseCut>) => props.onChange({ ...cut, ...p });
  return (
    <div className="space-y-3 text-xs">
      <CtField label="Cách cắt">
        <CtSelect<CtBaseCutMode> value={cut.mode} onChange={(mode) => set({ mode })} options={MODES} />
      </CtField>
      {cut.mode === "khuon" && !props.template && <p className="text-amber-600">Chọn khuôn in ở mục “Khuôn in + phôi” — chưa có khuôn thì file in không cắt được.</p>}
      {cut.mode === "alpha" && (
        <CtField label="Viền acrylic quanh thiết kế (mm)">
          <CtInput className="h-8 w-28" inputMode="decimal" value={String(cut.borderMm)} onChange={(e) => set({ borderMm: Math.max(0, Math.min(20, Number(e.target.value) || 0)) })} />
        </CtField>
      )}
      {cut.mode === "alpha" && (
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2">
            <input type="checkbox" className="accent-sky-500" checked={cut.hole} onChange={(e) => set({ hole: e.target.checked })} />
            Tai treo có lỗ ở mép trên
          </label>
          {cut.hole && (
            <label className="flex items-center gap-1.5 text-muted-foreground">
              Cỡ tai
              <CtInput className="h-7 w-16" inputMode="decimal" value={String(cut.holeSize)} onChange={(e) => set({ holeSize: Math.max(3, Math.min(30, Number(e.target.value) || 9)) })} />% bề rộng
            </label>
          )}
        </div>
      )}
      <p className="text-muted-foreground">
        {cut.mode === "khuon"
          ? "Nét liền của khuôn = đường cắt (mọi nội dung nằm trong đó), nét đứt = vùng an toàn cho option / ảnh khách. File in luôn có silhouette = hình trong nét liền."
          : cut.mode === "alpha"
            ? "Mỗi version tự có đường cắt + silhouette theo chính hình thiết kế (không vẽ tay từng version như Teeinblue)."
            : "File in = nguyên canvas artwork + silhouette theo hình thiết kế."}
      </p>
    </div>
  );
}

/** The design's box on a photo: the middle `share` of its shorter side, `aspect` = width / height. */
function boxFor(width: number, height: number, aspect: number, share: number, cx: number, cy: number): CtProductScene["box"] {
  const side = Math.min(width, height) * share;
  const w = aspect >= 1 ? side : side * aspect;
  const h = aspect >= 1 ? side / aspect : side;
  return { x: cx * width - w / 2, y: cy * height - h / 2, w, h };
}

export function BasePreviewSection(props: {
  baseId: string;
  cfg: CtBaseProductConfig;
  template: CtPrintTemplate | null;
  /** The automatic 3 backgrounds being made (server/base-scenes.ts). */
  auto: CtBaseScenesAuto | null;
  onChange: (preview: CtProductScene) => void;
  /** A new AI background: added to the list and made the preview. */
  onScene: (scene: CtBaseScene) => void;
  onScenes: (scenes: CtBaseScene[]) => void;
  /** The base's last save (the store state is read again after it). */
  savedAt: string;
  /** Scenes made on the server meanwhile (@flexiprint): added to the page's list. */
  onRemoteScenes: (scenes: CtBaseScene[]) => void;
}) {
  const { preview, cut } = props.cfg;
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const area = props.cfg.printAreas[0];
  const sheet = props.template?.spec ?? (area ? { width: area.width, height: area.height } : { width: 1000, height: 1000 });
  const aspect = sheet.width / sheet.height;
  const blank = cut.mode === "khuon" ? props.template?.spec.blanks[0] : undefined;
  // What the preview uses now: the base's own photo, else (a khuôn) its first phôi.
  const shown: CtProductScene | null = preview.url ? preview : blank ? { url: blank.url, width: blank.width, height: blank.height, box: blank.box } : null;
  const share = preview.url ? Math.max(preview.box.w, preview.box.h) / Math.min(preview.width, preview.height) : 0.7;
  const cx = preview.url ? (preview.box.x + preview.box.w / 2) / preview.width : 0.5;
  const cy = preview.url ? (preview.box.y + preview.box.h / 2) / preview.height : 0.5;

  const upload = async (f: File) => {
    setBusy(true);
    setError(null);
    try {
      const r = await printApi.uploadImage(f);
      props.onChange({ url: r.url, width: r.width, height: r.height, box: boxFor(r.width, r.height, aspect, 0.7, 0.5, 0.5) });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tải được ảnh");
    } finally {
      setBusy(false);
    }
  };
  const move = (p: { share?: number; cx?: number; cy?: number }) => {
    if (!preview.url) return;
    props.onChange({ ...preview, box: boxFor(preview.width, preview.height, aspect, p.share ?? share, p.cx ?? cx, p.cy ?? cy) });
  };
  const slider = (label: string, v: number, min: number, max: number, on: (n: number) => void) => (
    <label className="flex items-center gap-1.5">
      <span className="w-20 text-muted-foreground">{label}</span>
      <input type="range" min={min} max={max} step={0.01} value={v} onChange={(e) => on(Number(e.target.value))} className="w-32 accent-sky-500" />
      <span className="w-10 tabular-nums">{Math.round(v * 100)}%</span>
    </label>
  );

  return (
    <div className="space-y-3 text-xs">
      <p className="text-muted-foreground">
        {cut.mode === "alpha"
          ? "Ảnh nền (cây thông, bàn…) — khi xem trước, thiết kế được đặt vào khung xanh và tự có tấm acrylic trong + viền sáng + bóng đổ theo đúng hình của từng version."
          : "Ảnh xem trước của mọi sản phẩm dùng base này: khách thấy thiết kế được dán vào khung nét đứt trên ảnh. Muốn sản phẩm trong ảnh to hơn / cảnh khác thì tạo nền AI bên dưới hoặc đổi ảnh. Không đặt ảnh riêng thì dùng phôi đầu tiên của khuôn in."}
      </p>
      <div className="flex gap-3">
        <div className="relative w-56 shrink-0 overflow-hidden rounded-lg border" style={CHECKER_STYLE}>
          {shown?.url ? (
            <div className="relative" style={{ aspectRatio: `${shown.width} / ${shown.height}` }}>
              <img src={shown.url} alt="Nền xem trước" className="absolute inset-0 h-full w-full" />
              {shown.overlay && <img src={shown.overlay} alt="" className="absolute inset-0 h-full w-full" />}
              <div
                className="absolute border-2 border-dashed border-sky-400"
                style={{
                  left: `${(shown.box.x / shown.width) * 100}%`,
                  top: `${(shown.box.y / shown.height) * 100}%`,
                  width: `${(shown.box.w / shown.width) * 100}%`,
                  height: `${(shown.box.h / shown.height) * 100}%`,
                }}
              />
            </div>
          ) : (
            <div className="flex aspect-square flex-col items-center justify-center gap-1 text-muted-foreground">
              <ImageIcon className="h-6 w-6 opacity-50" />
              Chưa có ảnh
            </div>
          )}
        </div>
        <div className="space-y-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void upload(f);
            }}
          />
          <div className="flex gap-2">
            <CtButton size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} {preview.url ? "Đổi ảnh" : cut.mode === "alpha" ? "Tải ảnh nền" : "Tải ảnh phôi riêng"}
            </CtButton>
            {preview.url && (
              <CtButton size="sm" variant="ghost" onClick={() => props.onChange({ url: null, width: 0, height: 0, box: { x: 0, y: 0, w: 0, h: 0 } })}>
                <Trash2 className="h-3.5 w-3.5" /> Bỏ
              </CtButton>
            )}
          </div>
          {preview.url ? (
            // Asked 2026-11-17 ("cái này để làm gì? thay đổi cái này phôi cũng đâu có to hay nhỏ theo được"): the sliders only
            // move the frame over the photo — tucked away, with what they are for.
            <details className="rounded-md border px-2 py-1.5">
              <summary className="cursor-pointer select-none text-muted-foreground">Căn khung tay (ít khi cần)</summary>
              <p className="mt-1.5 text-muted-foreground">
                Chỉ dời / đổi cỡ <b>khung nét đứt</b> (chỗ dán thiết kế) trên ảnh — ảnh và sản phẩm trong ảnh giữ nguyên. Dùng khi bạn tự tải ảnh phôi lên và khung chưa nằm đúng mặt sản phẩm. Ảnh do AI vẽ đã tự khớp khung, không cần chỉnh. Khung to hơn sản phẩm thì thiết kế tràn ra ngoài / bị cắt.
              </p>
              <div className="mt-1.5 space-y-1">
                {slider("Cỡ khung", share, 0.2, 2.5, (v) => move({ share: v }))}
                {slider("Ngang", cx, 0, 1, (v) => move({ cx: v }))}
                {slider("Dọc", cy, 0, 1, (v) => move({ cy: v }))}
              </div>
            </details>
          ) : blank ? (
            <p className="text-muted-foreground">Đang dùng phôi đầu tiên của khuôn “{props.template?.name}”.</p>
          ) : (
            <p className="text-amber-600">Chưa có — xem trước sẽ chỉ là thiết kế trơn.</p>
          )}
          {error && <p className="text-destructive">{error}</p>}
        </div>
      </div>
      <SceneMaker baseId={props.baseId} cfg={props.cfg} auto={props.auto} blank={blank ? { url: blank.url, width: blank.width, height: blank.height, box: blank.box } : null} onChange={props.onChange} onScene={props.onScene} onScenes={props.onScenes} />
      <AgentPreviewBox baseId={props.baseId} scenes={props.cfg.previewScenes} onRemoteScenes={props.onRemoteScenes} onPick={props.onChange} />
      <StoreSync baseId={props.baseId} savedAt={props.savedAt} />
    </div>
  );
}

const TEMPLATES: Array<{ preset: Exclude<CtBaseScenePreset, "custom">; label: string; hint: string }> = [
  { preset: "home", label: "Nơi dùng quen thuộc", hint: "Chỗ sản phẩm hay được đặt / dùng, trong nhà ấm cúng" },
  { preset: "holiday", label: "Giáng sinh · quà tặng", hint: "Cùng chỗ đó, trang trí mùa lễ" },
  { preset: "minimal", label: "Tối giản, sáng", hint: "Ít đồ, sáng sủa, sản phẩm nổi bật" },
];

const PRESET_LABEL: Record<CtBaseScenePreset, string> = { home: "Quen thuộc", holiday: "Giáng sinh", minimal: "Tối giản", custom: "Tự mô tả" };

/**
 * AI backgrounds of the preview: 3 templates + the editor's own words. The AI gets the plain phôi and the base's info
 * (name, type, sizes, description, the fulfiller's photos) and works out where the product lives.
 */
function SceneMaker(props: {
  baseId: string;
  cfg: CtBaseProductConfig;
  auto: CtBaseScenesAuto | null;
  blank: CtProductScene | null;
  onChange: (preview: CtProductScene) => void;
  onScene: (scene: CtBaseScene) => void;
  onScenes: (scenes: CtBaseScene[]) => void;
}) {
  const { preview, previewScenes, cut } = props.cfg;
  const [mine, setMaking] = useState<CtBaseScenePreset | null>(null);
  const autoRunning = props.auto?.status === "running";
  const making = mine ?? (autoRunning ? "home" : null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const alpha = cut.mode === "alpha";
  const current = previewScenes.find((sc) => sc.scene.url && sc.scene.url === preview.url) ?? null;
  // "Phôi trơn" = what the preview was before a background was picked (url null = the khuôn's first phôi).
  const plain = current ? current.plain : preview;
  const plainShown = plain.url ? plain : alpha ? null : props.blank;
  const overlay = !alpha && !!plainShown?.overlay;
  const ready = alpha || !!plainShown?.url;

  const make = async (preset: CtBaseScenePreset) => {
    if (making) return;
    setMaking(preset);
    setError(null);
    try {
      const sc = await ctApi.makeBaseScene(props.baseId, { preset, prompt: preset === "custom" ? text.trim() : "", source: plainShown ?? defaultScene(), plain });
      props.onScene(sc);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tạo được nền");
    } finally {
      setMaking(null);
    }
  };
  const remove = (sc: CtBaseScene) => {
    props.onScenes(previewScenes.filter((x) => x.id !== sc.id));
    if (current?.id === sc.id) props.onChange(sc.plain);
  };
  const tile = (key: string, url: string | null, label: string, on: boolean, pick: () => void, drop?: () => void, loss?: CtSideLoss | null) => (
    <div key={key} className="group relative w-20 shrink-0">
      <button type="button" onClick={pick} className={`block w-20 overflow-hidden rounded-md border-2 ${on ? "border-sky-500" : "border-transparent hover:border-muted-foreground/40"}`}>
        {url ? <img src={url} alt={label} className="aspect-square w-full object-cover" /> : <div className="flex aspect-square w-full items-center justify-center bg-muted text-muted-foreground"><ImageIcon className="h-4 w-4" /></div>}
      </button>
      <div className="mt-0.5 truncate text-center text-[10px] text-muted-foreground">{label}</div>
      {loss && <LossLine loss={loss} />}
      {drop && (
        <button type="button" onClick={drop} title="Xoá nền này" className="absolute right-0.5 top-0.5 hidden rounded bg-black/60 p-0.5 text-white group-hover:block">
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );

  return (
    <div className="space-y-2 border-t pt-3">
      <div className="font-medium text-foreground">Nền bối cảnh (AI)</div>
      {overlay && (
        <p className="text-muted-foreground">
          Phôi có lớp phủ của nhà in: AI vẽ lại cả ảnh theo nền bạn chọn — sản phẩm phẳng (chăn) treo thẳng, không người, to và đúng tỉ lệ khuôn in — rồi tự tách lại phôi trơn + lớp phủ + khung như ảnh nhà in. Ô tự mô tả chỉ cần tả nơi đặt / phong cách; kích thước, mặt in và cách tách hệ thống tự lo.
        </p>
      )}
      {!ready ? (
        <p className="text-amber-600">Chưa có phôi trơn — tạo hoặc tải phôi trước, AI sẽ đặt nó vào bối cảnh.</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {TEMPLATES.map((t) => (
              <CtButton key={t.preset} size="sm" variant="outline" title={t.hint} disabled={!!making} onClick={() => void make(t.preset)}>
                {making === t.preset ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} {t.label}
              </CtButton>
            ))}
          </div>
          <div className="flex gap-2">
            <CtInput className="h-8 flex-1" value={text} placeholder="Hoặc tự mô tả nền: sàn gỗ phòng khách, cạnh sofa xám, có chậu cây…" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && text.trim() && void make("custom")} />
            <CtButton size="sm" variant="primary" disabled={!!making || !text.trim()} onClick={() => void make("custom")}>
              {making === "custom" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} Tạo nền
            </CtButton>
          </div>
          {mine && <p className="text-muted-foreground">{overlay ? "AI đang vẽ lại ảnh và tách lớp phủ (~1 – 3 phút)…" : "AI đang đọc thông tin sản phẩm và vẽ nền (~30 giây – 2 phút)…"}</p>}
        </>
      )}
      {props.auto && props.auto.status !== "idle" && (
        <p className={props.auto.status === "failed" ? "text-amber-600" : "text-muted-foreground"}>
          {autoRunning && <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />}
          {autoRunning ? `Tạo sẵn 3 nền: ${props.auto.step}` : props.auto.step}
        </p>
      )}
      {error && <p className="text-destructive">{error}</p>}
      {(previewScenes.length > 0 || current) && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {tile("plain", plainShown?.url ?? null, "Phôi trơn", !current, () => current && props.onChange(current.plain))}
          {previewScenes
            .slice()
            .reverse()
            .map((sc) => tile(sc.id, sc.scene.url, sc.preset === "custom" ? sc.prompt : PRESET_LABEL[sc.preset], current?.id === sc.id, () => props.onChange(sc.scene), () => remove(sc), sc.loss))}
        </div>
      )}
      {current && !current.found && <p className="text-amber-600">Không dò lại được phôi trên ảnh này — xem khung xanh, lệch thì chỉnh bằng thanh trượt ở trên.</p>}
    </div>
  );
}

/** "che ≤ 1 %" / the worst side, red from 5 % (the print sheet's share the overlay hides, measured when drawn). */
function LossLine({ loss }: { loss: CtSideLoss }) {
  const sides: Array<[keyof CtSideLoss, string]> = [["top", "trên"], ["bottom", "dưới"], ["left", "trái"], ["right", "phải"]];
  const [k, label] = sides.reduce((a, b) => (loss[b[0]] > loss[a[0]] ? b : a));
  const v = Math.round(loss[k] * 100);
  return (
    <div
      className={`truncate text-center text-[10px] ${v >= 5 ? "text-red-500" : "text-emerald-600"}`}
      title={`Thiết kế bị che: trên ${Math.round(loss.top * 100)}% · dưới ${Math.round(loss.bottom * 100)}% · trái ${Math.round(loss.left * 100)}% · phải ${Math.round(loss.right * 100)}%`}
    >
      {v <= 1 ? "che ≤ 1%" : `che ${v}% ${label}`}
    </div>
  );
}

/**
 * "Gửi @flexiprint" (asked 2026-11-17): the agent measures what the preview hides, looks at real designs on it, draws
 * new preview photos and recommends one (server/mcp/base-preview-tools.ts). Its scenes land in the list below as they
 * are made; the recommended one can be picked here, then Lưu.
 */
function AgentPreviewBox(props: { baseId: string; scenes: CtBaseScene[]; onRemoteScenes: (scenes: CtBaseScene[]) => void; onPick: (preview: CtProductScene) => void }) {
  const [request, setRequest] = useState("");
  const [task, setTask] = useState<CtAgentTask | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seen = useRef(0);
  const { baseId } = props;
  // The page passes a fresh function each render: read through a ref so the polling keeps its rhythm.
  const remote = useRef(props.onRemoteScenes);
  useEffect(() => {
    remote.current = props.onRemoteScenes;
  });
  const live = !!task && ["pending", "running", "waiting"].includes(task.status);

  const pull = useCallback(async () => {
    const list = await ctApi.listAgentTasks("base_preview", baseId);
    const t = list[0] ?? null;
    setTask(t);
    const n = (t?.progress ?? []).length;
    // New lines (a scene drawn) or the end: the base's scenes read again.
    if (t && (n !== seen.current || !["pending", "running", "waiting"].includes(t.status))) {
      seen.current = n;
      const d = await ctApi.getBaseProduct(baseId);
      remote.current(d.base.config.previewScenes);
    }
  }, [baseId]);

  useEffect(() => {
    void pull().catch(() => undefined);
    // Only on open: the polling below follows a running task.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseId]);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => void pull().catch(() => undefined), 6000);
    return () => clearInterval(t);
  }, [live, pull]);

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      const t = await ctApi.createAgentTask({
        kind: "base_preview",
        input: { category: { id: null, name: "", spec: "", rules: defaultCategoryRules() }, note: "", images: [], refUrls: [], basePreview: { baseId, baseName: "", request: request.trim() } },
      });
      setTask(t);
      seen.current = 0;
      setRequest("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không gửi được cho @flexiprint");
    } finally {
      setSending(false);
    }
  };

  const result = task?.status === "done" ? (task.result as CtBasePreviewResult | null) : null;
  const picked = result?.sceneId ? props.scenes.find((sc) => sc.id === result.sceneId) ?? null : null;
  const lines = (task?.progress ?? []).slice(-4);
  return (
    <div className="space-y-2 border-t pt-3">
      <div className="font-medium text-foreground">Nhờ @flexiprint làm preview</div>
      <p className="text-muted-foreground">
        Agent tự đo phần thiết kế bị che, ghép thử thiết kế thật của các sản phẩm lên ảnh, tìm nguyên nhân, vẽ vài nền mới rồi đề xuất 1 nền. Muốn agent đặt luôn làm preview thì ghi “đặt luôn”.
      </p>
      <CtTextarea rows={2} value={request} disabled={live} placeholder="VD: chăn treo giường tầng phòng bé, hợp các mẫu thể thao; hiện trọn tên ở dưới; đặt luôn" onChange={(e) => setRequest(e.target.value)} />
      <div className="flex items-center gap-2">
        <CtButton size="sm" variant="outline" disabled={live || sending} onClick={() => void send()}>
          {sending || live ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bot className="h-3.5 w-3.5" />} {live ? "@flexiprint đang làm…" : "Gửi @flexiprint"}
        </CtButton>
        {live && task && (
          <button type="button" className="text-[11px] text-muted-foreground hover:underline" onClick={() => void ctApi.cancelAgentTask(task.id).then(setTask).catch(() => undefined)}>
            Dừng
          </button>
        )}
      </div>
      {live && lines.length > 0 && (
        <ul className="space-y-0.5 text-muted-foreground">
          {lines.map((l, i) => (
            <li key={i} className="truncate">· {l.text}</li>
          ))}
        </ul>
      )}
      {task?.status === "failed" && <p className="text-amber-600">@flexiprint dừng: {task.error}</p>}
      {result && (
        <div className="space-y-1 rounded-md border p-2">
          <p className="whitespace-pre-wrap">{result.summary}</p>
          {picked && (
            <CtButton size="sm" variant="outline" onClick={() => props.onPick(picked.scene)}>
              Chọn nền agent đề xuất
            </CtButton>
          )}
          {picked && <span className="ml-2 text-[11px] text-muted-foreground">rồi bấm Lưu{result.applied ? " (agent đã đặt sẵn trên server)" : ""}</span>}
        </div>
      )}
      {error && <p className="text-destructive">{error}</p>}
    </div>
  );
}

/**
 * The store reads published templates only (asked 2026-11-17: "base thay đổi ảnh preview thì các sản phẩm dùng nó có
 * thay đổi không?"): after a save, the products already on the store whose preview is still the old one, and one
 * click to publish them again (template only — Shopify product, photos, price stay).
 */
function StoreSync(props: { baseId: string; savedAt: string }) {
  const [state, setState] = useState<CtBaseStoreState | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(() => {
    ctApi.baseStoreState(props.baseId).then(setState).catch(() => setState(null));
  }, [props.baseId]);
  useEffect(load, [load, props.savedAt]);
  if (!state || !state.deployed) return null;
  const run = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await ctApi.republishBase(props.baseId);
      setNote(`Đã cập nhật ${r.published} sản phẩm — store nhận trong vài phút${r.failed.length ? ` · lỗi ${r.failed.length}: ${r.failed[0]}` : ""}`);
      load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Không cập nhật được");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-1 border-t pt-3">
      <div className="flex items-center gap-2">
        <Store className="h-3.5 w-3.5 text-muted-foreground" />
        {state.stale.length ? (
          <span className="text-amber-600">
            Trong flexi2 mọi sản phẩm đã theo base; trên store còn {state.stale.length}/{state.deployed} sản phẩm đã deploy đang hiện ảnh xem trước cũ.
          </span>
        ) : (
          <span className="text-muted-foreground">Store đã khớp base ({state.deployed} sản phẩm đã deploy).</span>
        )}
        <button type="button" title="Kiểm tra lại" className="ml-auto rounded p-1 hover:bg-accent" onClick={load}>
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>
      {state.stale.length > 0 && (
        <CtButton size="sm" variant="primary" disabled={busy} onClick={() => void run()} title={state.stale.map((p) => p.name).join("\n")}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Store className="h-3.5 w-3.5" />} Cập nhật store ({state.stale.length} sản phẩm)
        </CtButton>
      )}
      {note && <p className="text-muted-foreground">{note}</p>}
    </div>
  );
}
