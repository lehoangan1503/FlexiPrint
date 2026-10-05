"use client";

/**
 * Tổ hợp → "Tăng chất lượng với AI tạo ảnh": the hand-made tổ hợp pictures
 * are remade as finished photos by an image model (ComfyUI recipe
 * mockup_enhance → FP Mockup Enhance). Every picture keeps its number (#1,
 * #2… as in the saved list): each chosen one is edited from itself, with the
 * others of the set as numbered references, so a prompt can say "light like
 * #2". One prompt for all + one per picture. Results are saved on the product
 * as new mockups.
 */

import { useEffect, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import type { CtAsset, CtStudioEnhanceItem } from "../../types";
import { ctApi } from "../../lib/api-client";
import { CHECKER_STYLE, CtButton, CtCheckbox, CtField, CtModal, CtSelect, CtTextarea, cx } from "../ui";

/** A saved tổ hợp with its number in the list. */
export interface EnhanceItem {
  asset: CtAsset;
  number: number;
}

/** Most pictures one run takes (the recipe's cap). */
const MAX_ITEMS = 12;

export function EnhanceDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productId: string;
  items: EnhanceItem[];
  /** Ticked when the dialog opens. */
  initial: string[];
  onAdded: (assets: CtAsset[]) => void;
  flash: (msg: string) => void;
}) {
  const { open, items } = props;
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [own, setOwn] = useState<Record<string, string>>({});
  const [chosen, setChosen] = useState<string[]>([]);
  const [withRefs, setWithRefs] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<CtAsset[]>([]);

  // Ticks follow what the panel had picked each time the dialog opens.
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setChosen(props.initial.filter((id) => items.some((i) => i.asset.id === id)).slice(0, MAX_ITEMS));
      setResults([]);
      setError(null);
    }
  }

  useEffect(() => {
    if (!open || models.length) return;
    ctApi
      .studioModels()
      .then((m) => {
        setModels(m);
        setModel((cur) => cur || m[0] || "");
      })
      .catch((e: Error) => setError(e.message));
  }, [open, models.length]);

  const running = status !== null;
  const toggle = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : c.length < MAX_ITEMS ? [...c, id] : c));

  const run = async () => {
    const targets = items.filter((i) => chosen.includes(i.asset.id));
    if (!targets.length) return setError("Tick ít nhất 1 tổ hợp");
    // The pictures the prompts may name: the chosen ones, plus the rest of the set as references.
    const pictures = (withRefs ? items : targets).slice(0, MAX_ITEMS);
    for (const t of targets) if (!pictures.includes(t)) pictures.push(t);
    setError(null);
    setResults([]);
    try {
      const refs: Array<{ number: number; ref: string }> = [];
      for (const [i, p] of pictures.entries()) {
        setStatus(`Gửi ảnh ${i + 1}/${pictures.length}…`);
        const blob = await fetch(p.asset.url).then((r) => {
          if (!r.ok) throw new Error(`Không tải được ảnh #${p.number}`);
          return r.blob();
        });
        refs.push({ number: p.number, ref: await ctApi.studioUploadRef(new File([blob], `to-hop-${p.number}.png`, { type: blob.type })) });
      }
      const refOf = (n: number) => refs.find((r) => r.number === n)?.ref ?? "";
      const list: CtStudioEnhanceItem[] = targets.map((t) => ({
        number: t.number,
        ref: refOf(t.number),
        name: `#${t.number} ${t.asset.name} · AI`,
        prompt: own[t.asset.id]?.trim() ?? "",
      }));
      setStatus("Đang xếp hàng AI…");
      const runId = await ctApi.studioRun({ recipe: "mockup_enhance", params: { product_id: props.productId, model, prompt: prompt.trim(), items: list, refs } });
      const seen = new Set<string>();
      for (;;) {
        await new Promise((r) => window.setTimeout(r, 2500));
        const st = await ctApi.studioRunStatus(runId);
        const fresh = st.assets.filter((a) => !seen.has(a.id));
        if (fresh.length) {
          fresh.forEach((a) => seen.add(a.id));
          props.onAdded(fresh);
          setResults((r) => [...r, ...fresh]);
        }
        if (st.status === "error") throw new Error(st.error ?? "AI lỗi");
        if (st.status === "done") {
          props.flash(`AI đã làm xong ${seen.size} ảnh — đã thêm vào Tổ hợp đã lưu`);
          break;
        }
        setStatus(st.status === "queued" ? `AI: đang chờ${st.position ? ` (#${st.position})` : ""}…` : `AI: ${seen.size}/${targets.length} ảnh xong…`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "AI thất bại");
    } finally {
      setStatus(null);
    }
  };

  return (
    <CtModal open={open} onOpenChange={(o) => !running && props.onOpenChange(o)} title="Tăng chất lượng với AI tạo ảnh" wide>
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">
          AI làm lại từng tổ hợp đã tick thành ảnh sản phẩm hoàn thiện — giữ bố cục, sản phẩm, chữ; làm thật ánh sáng, bóng đổ, chất liệu. Các tổ hợp được đánh số
          như bên dưới: prompt có thể nhắc “#2” để chỉ ảnh đó. Kết quả lưu thành tổ hợp mới, ảnh cũ giữ nguyên.
        </p>
        <div className="grid grid-cols-[1fr_220px] gap-3">
          <CtField label="Prompt chung (mọi tổ hợp)">
            <CtTextarea
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="vd. ánh sáng ấm buổi sáng, bàn gỗ mờ phía sau, bóng đổ mềm, phong cách ảnh Etsy cao cấp…"
              disabled={running}
            />
          </CtField>
          <div className="space-y-3">
            <CtField label="Model">
              <CtSelect value={model} onChange={setModel} options={models.map((m) => ({ value: m, label: m }))} disabled={running || !models.length} />
            </CtField>
            <CtCheckbox checked={withRefs} onChange={setWithRefs} label="Tham khảo cả bộ" hint="Gửi kèm các tổ hợp khác làm ảnh tham khảo (#n)" />
          </div>
        </div>

        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {items.map(({ asset, number }) => {
            const on = chosen.includes(asset.id);
            return (
              <div key={asset.id} className={cx("space-y-2 rounded-lg border p-2", on && "border-sky-500 bg-sky-500/5")}>
                <button className="relative block aspect-square w-full overflow-hidden rounded border" style={CHECKER_STYLE} onClick={() => toggle(asset.id)} disabled={running}>
                  <img src={asset.url} alt="" className="h-full w-full object-contain" loading="lazy" />
                  <span className="absolute left-1.5 top-1.5 rounded bg-black/75 px-1.5 py-0.5 text-xs font-bold text-white">#{number}</span>
                  <span className={cx("absolute right-1.5 top-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium", on ? "bg-sky-500 text-white" : "bg-background/90 text-muted-foreground")}>
                    {on ? "Làm lại" : "Chỉ tham khảo"}
                  </span>
                </button>
                <p className="truncate text-[11px] text-muted-foreground">{asset.name}</p>
                {on && (
                  <CtTextarea
                    rows={2}
                    className="text-xs"
                    placeholder={`Riêng #${number}: vd. nền bàn đá, ánh sáng giống #${number === 1 ? 2 : 1}…`}
                    value={own[asset.id] ?? ""}
                    onChange={(e) => setOwn((o) => ({ ...o, [asset.id]: e.target.value }))}
                    disabled={running}
                  />
                )}
              </div>
            );
          })}
        </div>

        {results.length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-semibold">Kết quả ({results.length})</p>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {results.map((a) => (
                <a key={a.id} href={a.url} target="_blank" rel="noopener noreferrer" className="block h-32 w-32 shrink-0 overflow-hidden rounded border" style={CHECKER_STYLE} title={a.name}>
                  <img src={a.url} alt="" className="h-full w-full object-cover" />
                </a>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 border-t pt-3">
          {status && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {status}
            </span>
          )}
          {error && <span className="text-xs text-destructive">{error}</span>}
          <span className="ml-auto flex gap-2">
            <CtButton variant="ghost" onClick={() => props.onOpenChange(false)} disabled={running}>
              Đóng
            </CtButton>
            <CtButton variant="primary" onClick={() => void run()} disabled={running || !chosen.length || !model}>
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Tạo {chosen.length} ảnh
            </CtButton>
          </span>
        </div>
      </div>
    </CtModal>
  );
}
