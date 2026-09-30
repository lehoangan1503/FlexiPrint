"use client";

/**
 * One AI request = one dialog submit. Used for main objects, sub objects,
 * versions of a sub object, and mockups — the role decides the prompt framing
 * (server/ai/prompts.ts) and where the results land.
 */

import { useEffect, useMemo, useState } from "react";
import { Check, Loader2, Sparkles } from "lucide-react";
import type { CtAiProviderId, CtAiProviderInfo, CtAspectRatio, CtAsset, CtAssetRole } from "../../types";
import { ctApi } from "../../lib/api-client";
import { CHECKER_STYLE, CtButton, CtCheckbox, CtField, CtModal, CtSelect, CtTextarea, cx } from "../ui";

const ROLE_TITLE: Record<CtAssetRole, string> = {
  main: "Tạo main object bằng AI",
  sub: "Tạo sub object bằng AI",
  variant: "Tạo version cho sub object",
  mockup: "Tạo mockup chuyên nghiệp",
  rendition: "",
  composite: "",
  reference: "",
};

const PLACEHOLDER: Record<CtAssetRole, string> = {
  main: "vd. Xửng hấp tre mở nắp nhìn chéo 3/4, vân tre đan chi tiết, phong cách minh hoạ bóng bẩy, không có bánh bên trong",
  sub: "vd. Bánh bao kawaii thân tròn, glitter cầu vồng lấp lánh, không có mặt",
  variant: "vd. Đổi biểu cảm thành mắt nhắm cười híp, má hồng",
  mockup: "vd. Treo trên cây thông Noel, đèn bokeh vàng ấm, cận cảnh, nền tối sang trọng",
  rendition: "",
  composite: "",
  reference: "",
};

const LS_KEY = "ct:gen-pref";

interface GenPref {
  provider: CtAiProviderId;
  model: string;
}

function readPref(): GenPref | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as GenPref) : null;
  } catch {
    return null;
  }
}

export interface GenerateDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  productId: string;
  role: CtAssetRole;
  parent: CtAsset | null;
  assets: CtAsset[];
  initialRefIds: string[];
  onDone: (assets: CtAsset[]) => void;
}

export function GenerateDialog(props: GenerateDialogProps) {
  const { open, role, parent, assets } = props;
  const [providers, setProviders] = useState<CtAiProviderInfo[]>([]);
  const [provider, setProvider] = useState<CtAiProviderId>("gemini");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [aspect, setAspect] = useState<CtAspectRatio>("1:1");
  const [count, setCount] = useState(2);
  const [transparent, setTransparent] = useState(false);
  const [refIds, setRefIds] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setRefIds(props.initialRefIds);
    setAspect(role === "mockup" ? "1:1" : "1:1");
    setCount(role === "mockup" ? 2 : role === "variant" ? 1 : 2);
    ctApi
      .providers()
      .then((list) => {
        setProviders(list);
        const pref = readPref();
        const usable = list.filter((p) => p.configured);
        const pick = usable.find((p) => p.id === pref?.provider) ?? usable[0] ?? list[0];
        if (pick) {
          setProvider(pick.id);
          setModel(pick.models.find((m) => m.id === pref?.model)?.id ?? pick.models[0]?.id ?? "");
        }
      })
      .catch((e: Error) => setError(e.message));
  }, [open, role, props.initialRefIds]);

  const providerInfo = providers.find((p) => p.id === provider);
  const modelInfo = providerInfo?.models.find((m) => m.id === model);
  const maxRefs = (modelInfo?.maxReferences ?? 8) - (parent ? 1 : 0);

  // Composites first for mockups — they are what a mockup is made of.
  const pickable = useMemo(() => {
    const list = assets.filter((a) => a.id !== parent?.id && a.role !== "mockup");
    return role === "mockup" ? [...list.filter((a) => a.role === "composite"), ...list.filter((a) => a.role !== "composite")] : list;
  }, [assets, parent, role]);

  const toggleRef = (id: string) =>
    setRefIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : ids.length >= maxRefs ? ids : [...ids, id]));

  const submit = async () => {
    setRunning(true);
    setError(null);
    try {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify({ provider, model }));
      } catch {
        // storage unavailable — preference just is not remembered
      }
      const res = await ctApi.generate(props.productId, {
        targetRole: role,
        parentAssetId: parent?.id ?? null,
        provider,
        model,
        prompt,
        referenceAssetIds: refIds,
        params: { aspectRatio: aspect, count, transparent: transparent && Boolean(modelInfo?.supportsTransparent) },
      });
      props.onDone(res.assets);
      props.onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Tạo ảnh thất bại");
    } finally {
      setRunning(false);
    }
  };

  const noProvider = providers.length > 0 && !providers.some((p) => p.configured);

  return (
    <CtModal open={open} onOpenChange={(o) => !running && props.onOpenChange(o)} title={ROLE_TITLE[role]} wide>
      <div className="grid gap-5 md:grid-cols-[1fr_340px]">
        <div className="space-y-3">
          {parent && (
            <div className="flex items-center gap-3 rounded-md border p-2">
              <div className="h-16 w-16 overflow-hidden rounded" style={CHECKER_STYLE}>
                <img src={parent.url} alt="" className="h-full w-full object-contain" />
              </div>
              <div className="text-xs text-muted-foreground">
                Sub object gốc — luôn là ảnh tham chiếu đầu tiên. AI giữ nguyên khung hình, kích thước và vị trí để version mới
                thay thế khớp từng pixel.
              </div>
            </div>
          )}
          <CtField label="Prompt">
            <CtTextarea rows={5} value={prompt} placeholder={PLACEHOLDER[role]} onChange={(e) => setPrompt(e.target.value)} />
          </CtField>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Ảnh tham chiếu ({refIds.length}/{Math.max(0, maxRefs)})
              </span>
              {refIds.length > 0 && (
                <button className="text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setRefIds([])}>
                  Bỏ chọn
                </button>
              )}
            </div>
            <div className="grid max-h-64 grid-cols-6 gap-1.5 overflow-y-auto">
              {pickable.map((a) => {
                const on = refIds.includes(a.id);
                return (
                  <button
                    key={a.id}
                    onClick={() => toggleRef(a.id)}
                    className={cx("relative aspect-square overflow-hidden rounded border", on && "ring-2 ring-sky-500")}
                    style={CHECKER_STYLE}
                    title={`${a.role}: ${a.name}`}
                  >
                    <img src={a.url} alt="" className="h-full w-full object-contain" loading="lazy" />
                    <span className="absolute left-0 top-0 rounded-br bg-black/60 px-1 text-[9px] text-white">{a.role}</span>
                    {on && (
                      <span className="absolute right-0.5 top-0.5 rounded-full bg-sky-500 p-0.5 text-white">
                        <Check className="h-2.5 w-2.5" />
                      </span>
                    )}
                  </button>
                );
              })}
              {pickable.length === 0 && <p className="col-span-6 text-xs text-muted-foreground">Chưa có asset nào để tham chiếu.</p>}
            </div>
          </div>
        </div>

        <div className="space-y-3">
          {noProvider && (
            <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-xs">
              Chưa cấu hình API key. Thêm <code>GEMINI_API_KEY</code> hoặc <code>OPENAI_API_KEY</code> vào <code>.env</code> rồi khởi động lại server.
            </div>
          )}
          <CtField label="Provider">
            <CtSelect<CtAiProviderId>
              value={provider}
              onChange={(p) => {
                setProvider(p);
                setModel(providers.find((x) => x.id === p)?.models[0]?.id ?? "");
              }}
              options={providers.map((p) => ({ value: p.id, label: `${p.label}${p.configured ? "" : " — chưa có key"}`, disabled: !p.configured }))}
            />
          </CtField>
          <CtField label="Model">
            <CtSelect value={model} onChange={setModel} options={(providerInfo?.models ?? []).map((m) => ({ value: m.id, label: m.label }))} />
          </CtField>
          <div className="grid grid-cols-2 gap-2">
            <CtField label="Tỉ lệ">
              <CtSelect<CtAspectRatio>
                value={aspect}
                onChange={setAspect}
                options={(["1:1", "3:4", "4:3", "9:16", "16:9"] as CtAspectRatio[]).map((v) => ({ value: v, label: v }))}
              />
            </CtField>
            <CtField label="Số ảnh">
              <CtSelect<string> value={String(count)} onChange={(v) => setCount(Number(v))} options={["1", "2", "3", "4"].map((v) => ({ value: v, label: v }))} />
            </CtField>
          </div>
          {role !== "mockup" && (
            <div className="space-y-1">
              <CtCheckbox
                checked={transparent && Boolean(modelInfo?.supportsTransparent)}
                onChange={setTransparent}
                label="Nền trong suốt (nếu model hỗ trợ)"
              />
              {!modelInfo?.supportsTransparent && (
                <p className="text-[11px] text-muted-foreground">
                  Model này không xuất alpha — AI vẽ trên nền trắng, sau đó dùng nút <b>Xoá nền</b> trên asset.
                </p>
              )}
            </div>
          )}
          {error && <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">{error}</div>}
          <CtButton variant="primary" className="w-full justify-center" onClick={submit} disabled={running || !prompt.trim() || !model || noProvider}>
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {running ? "Đang tạo… (10–60s)" : `Tạo ${count} ảnh`}
          </CtButton>
        </div>
      </div>
    </CtModal>
  );
}
