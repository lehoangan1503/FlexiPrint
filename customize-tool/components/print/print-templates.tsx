"use client";

/**
 * /templates — Khuôn in (server/print-templates.ts). A template is the piece, not a design: the print file's size,
 * the cut line, the safe zone, what is cut out (a hanging hole), the named zones a layer can fill, the sizes. Every
 * product printed on the same piece starts from it ("Tạo sản phẩm"): its canvas is the sheet, the cut line its
 * khuôn vật liệu, and the editor shows the safe zone over the design.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, Copy, ImagePlus, Loader2, PenLine, Plus, Ruler, Trash2, Undo2, X } from "lucide-react";
import type { CtShape } from "../../types";
import type { CtPrintKind, CtPrintSpec, CtPrintTemplate, CtPrintZone } from "../../types/print";
import { CT_CONFIG } from "../../config";
import { insetShape, PRINT_PRESETS } from "../../lib/print-template";
import { newId, shapeBounds } from "../../lib/geometry";
import { printApi } from "../../lib/print-api";
import { CtButton, CtField, CtInput, CtModal, CtNumber, CtSelect, CtTextarea, cx } from "../ui";
import { PrintSheet, ZONE_COLOURS } from "./print-sheet";

const KINDS: Array<{ value: CtPrintKind; label: string; hint: string }> = [
  { value: "flat", label: "Phẳng, cắt theo khuôn", hint: "Ornament, tile, poster, ly — một mặt, đường cắt cố định" },
  { value: "cut", label: "Cắt theo viền hình", hint: "Sticker, acrylic, ảnh khách tách nền — đường cắt = viền artwork + khoảng đệm" },
  { value: "panels", label: "Nhiều vùng / may", hint: "Quần áo in toàn thân, gối — vùng có tên, nhiều cỡ" },
];

type OutlineKind = "none" | "circle" | "rect";

function outlineKind(spec: CtPrintSpec): OutlineKind {
  if (!spec.outline) return "none";
  return spec.outline.type === "ellipse" ? "circle" : "rect";
}

/** The cut line of a kind, inset `margin` px from the sheet. */
function makeOutline(kind: OutlineKind, spec: CtPrintSpec, margin: number, radius: number): CtShape | null {
  if (kind === "none") return null;
  if (kind === "circle") return { type: "ellipse", cx: spec.width / 2, cy: spec.height / 2, rx: spec.width / 2 - margin, ry: spec.height / 2 - margin };
  return { type: "rect", x: margin, y: margin, w: spec.width - 2 * margin, h: spec.height - 2 * margin, radius };
}

function outlineMargin(spec: CtPrintSpec): number {
  if (!spec.outline) return 0;
  const b = shapeBounds(spec.outline);
  return Math.round(Math.min(b.x, b.y));
}

function safeInset(spec: CtPrintSpec): number {
  if (!spec.outline || !spec.safe[0]) return 0;
  const a = shapeBounds(spec.outline);
  const b = shapeBounds(spec.safe[0]);
  return Math.round(Math.min(b.x - a.x, b.y - a.y));
}

export function PrintTemplatesPage() {
  const router = useRouter();
  const [templates, setTemplates] = useState<CtPrintTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CtPrintTemplate | null>(null);
  const [making, setMaking] = useState<CtPrintTemplate | null>(null);

  useEffect(() => {
    printApi
      .list()
      .then(setTemplates)
      .catch((e: Error) => setError(e.message));
  }, []);

  const add = async (preset: number | null) => {
    setError(null);
    try {
      const p = preset === null ? null : PRINT_PRESETS[preset];
      const t = await printApi.create(p ? { name: `${p.name} (bản sao)`, kind: p.kind, spec: p.spec } : { name: "Khuôn mới", kind: "flat", spec: PRINT_PRESETS[0].spec });
      setTemplates((cur) => [...(cur ?? []), t]);
      setEditing(t);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tạo được");
    }
  };

  const duplicate = async (t: CtPrintTemplate) => {
    try {
      const c = await printApi.create({ name: `${t.name} (bản sao)`, kind: t.kind, spec: t.spec });
      setTemplates((cur) => [...(cur ?? []), c]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không nhân bản được");
    }
  };

  const remove = async (t: CtPrintTemplate) => {
    if (!window.confirm(`Xoá khuôn "${t.name}"? Sản phẩm đã làm từ khuôn giữ bản sao của nó.`)) return;
    try {
      await printApi.remove(t.id);
      setTemplates((cur) => (cur ?? []).filter((x) => x.id !== t.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không xoá được");
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b bg-card/80 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
          <Link href={CT_CONFIG.homePath} className="rounded p-1.5 hover:bg-accent">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <h1 className="text-lg font-semibold">Khuôn in</h1>
          <span className="hidden text-xs text-muted-foreground sm:inline">Kích thước file in, đường cắt, safe zone, vùng — dùng lại cho mọi sản phẩm in trên cùng phôi</span>
          <div className="ml-auto flex gap-2">
            <CtButton variant="primary" onClick={() => void add(null)}>
              <Plus className="h-4 w-4" /> Khuôn mới
            </CtButton>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl space-y-4 px-4 py-6 sm:px-6 lg:px-8">
        {error && <p className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">{error}</p>}
        {!templates && !error && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Đang tải…
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {(templates ?? []).map((t) => (
            <div key={t.id} className="overflow-hidden rounded-xl border bg-card">
              <button className="block w-full bg-muted/40 p-3" onClick={() => setEditing(t)} title="Sửa khuôn">
                <PrintSheet spec={t.spec} className="mx-auto h-56 w-full" />
              </button>
              <div className="space-y-2 p-3">
                <div className="truncate text-sm font-semibold" title={t.name}>
                  {t.name}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {KINDS.find((k) => k.value === t.kind)?.label} · {t.spec.width}×{t.spec.height}px
                  {t.spec.widthMm ? ` · ${t.spec.widthMm}×${t.spec.heightMm}mm` : ""}
                  {t.spec.sizes.length ? ` · ${t.spec.sizes.length} cỡ` : ""}
                  {t.spec.zones.length ? ` · ${t.spec.zones.length} vùng` : ""}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <CtButton size="sm" variant="primary" onClick={() => setMaking(t)}>
                    <Plus className="h-3.5 w-3.5" /> Tạo sản phẩm
                  </CtButton>
                  <CtButton size="sm" onClick={() => setEditing(t)}>
                    <PenLine className="h-3.5 w-3.5" /> Sửa
                  </CtButton>
                  <CtButton size="sm" onClick={() => void duplicate(t)} title="Nhân bản">
                    <Copy className="h-3.5 w-3.5" />
                  </CtButton>
                  <CtButton size="sm" onClick={() => void remove(t)} title="Xoá">
                    <Trash2 className="h-3.5 w-3.5" />
                  </CtButton>
                </div>
              </div>
            </div>
          ))}
        </div>
        {templates && (
          <div className="rounded-xl border bg-card p-4 text-xs text-muted-foreground">
            <div className="mb-2 font-medium text-foreground">Thêm từ mẫu có sẵn</div>
            <div className="flex flex-wrap gap-2">
              {PRINT_PRESETS.map((p, i) => (
                <CtButton key={p.name} size="sm" onClick={() => void add(i)}>
                  <Plus className="h-3.5 w-3.5" /> {p.name}
                </CtButton>
              ))}
            </div>
          </div>
        )}
      </main>
      {editing && (
        <TemplateEditor
          template={editing}
          onClose={() => setEditing(null)}
          onSaved={(t) => {
            setTemplates((cur) => (cur ?? []).map((x) => (x.id === t.id ? t : x)));
            setEditing(t);
          }}
        />
      )}
      {making && <MakeProduct template={making} onClose={() => setMaking(null)} onMade={(id) => router.push(`${CT_CONFIG.basePath}/${id}`)} />}
    </div>
  );
}

function MakeProduct({ template, onClose, onMade }: { template: CtPrintTemplate; onClose: () => void; onMade: (productId: string) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      const p = await printApi.createProduct(template.id, name.trim() || template.name);
      onMade(p.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tạo được");
      setBusy(false);
    }
  };
  return (
    <CtModal open onOpenChange={(o) => !o && onClose()} title={`Sản phẩm mới trên "${template.name}"`}>
      <div className="space-y-3">
        <CtField label="Tên sản phẩm">
          <CtInput autoFocus value={name} placeholder={template.name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void make()} />
        </CtField>
        <p className="text-xs text-muted-foreground">
          Khung thiết kế = tờ in {template.spec.width}×{template.spec.height}px; đường cắt thành khuôn vật liệu (file in cắt theo nó); editor hiện safe zone và báo khi hình / chữ nằm ngoài.
        </p>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <CtButton onClick={onClose}>Huỷ</CtButton>
          <CtButton variant="primary" disabled={busy} onClick={() => void make()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Tạo
          </CtButton>
        </div>
      </div>
    </CtModal>
  );
}

// ---- the editor ------------------------------------------------------------------------------------------

function TemplateEditor({ template, onClose, onSaved }: { template: CtPrintTemplate; onClose: () => void; onSaved: (t: CtPrintTemplate) => void }) {
  const [name, setName] = useState(template.name);
  const [kind, setKind] = useState<CtPrintKind>(template.kind);
  const [spec, setSpec] = useState<CtPrintSpec>(template.spec);
  const [margin, setMargin] = useState(outlineMargin(template.spec));
  const [radius, setRadius] = useState(template.spec.outline?.type === "rect" ? template.spec.outline.radius : 0);
  const [inset, setInset] = useState(safeInset(template.spec));
  const [drawing, setDrawing] = useState<{ id: string | null; points: Array<{ x: number; y: number }> } | null>(null);
  const [sizeId, setSizeId] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const svgWrap = useRef<HTMLDivElement | null>(null);
  const dirty = name !== template.name || kind !== template.kind || JSON.stringify(spec) !== JSON.stringify(template.spec);

  const set = (patch: Partial<CtPrintSpec>) => setSpec((cur) => ({ ...cur, ...patch }));

  /** Cut line + safe zone follow the simple controls (circle / rect, margin, radius, safe inset). */
  const reshape = (k: OutlineKind, m: number, r: number, ins: number, base: CtPrintSpec = spec) => {
    const outline = makeOutline(k, base, m, r);
    setSpec({ ...base, outline, safe: outline && ins > 0 ? [insetShape(outline, ins)] : outline ? [] : base.safe });
  };

  const resize = (w: number, h: number) => {
    const next = { ...spec, width: Math.max(16, Math.round(w)), height: Math.max(16, Math.round(h)) };
    if (next.dpi) {
      next.widthMm = Math.round((next.width / next.dpi) * 25.4 * 10) / 10;
      next.heightMm = Math.round((next.height / next.dpi) * 25.4 * 10) / 10;
    }
    reshape(outlineKind(spec), margin, radius, inset, next);
  };

  const upload = async (field: "frameUrl" | "blankUrl", file: File | undefined) => {
    if (!file) return;
    setBusy(field);
    try {
      const r = await printApi.uploadImage(file);
      if (field === "frameUrl" && (r.width !== spec.width || r.height !== spec.height) && window.confirm(`Ảnh khung ${r.width}×${r.height}px khác cỡ tờ in ${spec.width}×${spec.height}px. Đổi cỡ tờ in theo ảnh?`)) {
        setSpec((cur) => ({ ...cur, frameUrl: r.url, width: r.width, height: r.height }));
      } else {
        set({ [field]: r.url } as Partial<CtPrintSpec>);
      }
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Upload thất bại" });
    } finally {
      setBusy(null);
    }
  };

  /** Sheet px under the pointer. */
  const at = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const m = svg.getScreenCTM();
    const p = m ? pt.matrixTransform(m.inverse()) : { x: 0, y: 0 };
    return { x: Math.round(p.x), y: Math.round(p.y) };
  };

  const finishZone = () => {
    if (!drawing || drawing.points.length < 3) return setDrawing(null);
    const shape: CtShape = { type: "polygon", points: drawing.points };
    if (drawing.id) set({ zones: spec.zones.map((z) => (z.id === drawing.id ? { ...z, shape } : z)) });
    else set({ zones: [...spec.zones, { id: newId().slice(0, 8), name: `Vùng ${spec.zones.length + 1}`, shape }] });
    setDrawing(null);
  };

  const save = async () => {
    setBusy("save");
    setMsg(null);
    try {
      const t = await printApi.update(template.id, { name, kind, spec });
      onSaved(t);
      setMsg({ ok: true, text: "Đã lưu" });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Không lưu được" });
    } finally {
      setBusy(null);
    }
  };

  const close = () => {
    if (dirty && !window.confirm("Bỏ thay đổi chưa lưu?")) return;
    onClose();
  };

  const ok = outlineKind(spec);
  const zoneOf = (z: CtPrintZone, patch: Partial<CtPrintZone>) => set({ zones: spec.zones.map((x) => (x.id === z.id ? { ...x, ...patch } : x)) });

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <Ruler className="h-4 w-4 text-muted-foreground" />
        <CtInput className="max-w-sm font-semibold" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="ml-auto flex items-center gap-2">
          {msg && <span className={cx("text-xs", msg.ok ? "text-emerald-600" : "text-destructive")}>{msg.text}</span>}
          <CtButton variant="primary" disabled={!dirty || busy === "save"} onClick={() => void save()}>
            {busy === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Lưu
          </CtButton>
          <button className="rounded p-1.5 hover:bg-accent" onClick={close} title="Đóng">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 lg:grid-cols-[420px_1fr]">
        <aside className="space-y-5 overflow-y-auto border-r p-4">
          <CtField label="Loại" hint={KINDS.find((k) => k.value === kind)?.hint}>
            <CtSelect<CtPrintKind> value={kind} options={KINDS.map((k) => ({ value: k.value, label: k.label }))} onChange={setKind} />
          </CtField>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">File in</h3>
            <div className="grid grid-cols-3 gap-2">
              <CtField label="Rộng px">
                <CtNumber value={spec.width} min={16} onChange={(v) => resize(v, spec.height)} />
              </CtField>
              <CtField label="Cao px">
                <CtNumber value={spec.height} min={16} onChange={(v) => resize(spec.width, v)} />
              </CtField>
              <CtField label="DPI">
                <CtNumber value={spec.dpi} min={30} onChange={(dpi) => set({ dpi, widthMm: Math.round((spec.width / dpi) * 254) / 10, heightMm: Math.round((spec.height / dpi) * 254) / 10 })} />
              </CtField>
              <CtField label="Rộng mm">
                <CtNumber value={spec.widthMm} min={0} onChange={(widthMm) => set({ widthMm })} />
              </CtField>
              <CtField label="Cao mm">
                <CtNumber value={spec.heightMm} min={0} onChange={(heightMm) => set({ heightMm })} />
              </CtField>
              <CtField label="Tràn lề px">
                <CtNumber value={spec.bleed} min={0} onChange={(bleed) => set({ bleed })} />
              </CtField>
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Đường cắt & safe zone</h3>
            <CtSelect<OutlineKind>
              value={ok}
              options={[
                { value: "none", label: "Không (cả tờ / cắt theo viền hình)" },
                { value: "circle", label: "Tròn / elip" },
                { value: "rect", label: "Chữ nhật (bo góc)" },
              ]}
              onChange={(k) => reshape(k, margin, radius, inset)}
            />
            {ok !== "none" && (
              <div className="grid grid-cols-3 gap-2">
                <CtField label="Cách mép px">
                  <CtNumber
                    value={margin}
                    min={0}
                    onChange={(m) => {
                      setMargin(m);
                      reshape(ok, m, radius, inset);
                    }}
                  />
                </CtField>
                {ok === "rect" && (
                  <CtField label="Bo góc px">
                    <CtNumber
                      value={radius}
                      min={0}
                      onChange={(r) => {
                        setRadius(r);
                        reshape(ok, margin, r, inset);
                      }}
                    />
                  </CtField>
                )}
                <CtField label="Safe vào trong px">
                  <CtNumber
                    value={inset}
                    min={0}
                    onChange={(i) => {
                      setInset(i);
                      reshape(ok, margin, radius, i);
                    }}
                  />
                </CtField>
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">Xanh liền = đường cắt (artwork phủ kín tới đây + tràn lề). Xanh nét đứt = safe zone: hình, chữ, vật chính phải nằm trong.</p>
          </section>

          <section className="space-y-2">
            <div className="flex items-center gap-2">
              <h3 className="flex-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Phần cắt bỏ (lỗ treo…)</h3>
              <CtButton size="sm" onClick={() => set({ cuts: [...spec.cuts, { type: "ellipse", cx: spec.width / 2, cy: Math.round(spec.height * 0.16), rx: Math.round(spec.width * 0.027), ry: Math.round(spec.width * 0.027) }] })}>
                <Plus className="h-3.5 w-3.5" /> Lỗ tròn
              </CtButton>
            </div>
            {spec.cuts.map((c, i) =>
              c.type === "ellipse" ? (
                <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-2">
                  <CtField label="Tâm X">
                    <CtNumber value={c.cx} onChange={(cx) => set({ cuts: spec.cuts.map((x, j) => (j === i ? { ...c, cx } : x)) })} />
                  </CtField>
                  <CtField label="Tâm Y">
                    <CtNumber value={c.cy} onChange={(cy) => set({ cuts: spec.cuts.map((x, j) => (j === i ? { ...c, cy } : x)) })} />
                  </CtField>
                  <CtField label="Bán kính">
                    <CtNumber value={c.rx} min={1} onChange={(r) => set({ cuts: spec.cuts.map((x, j) => (j === i ? { ...c, rx: r, ry: r } : x)) })} />
                  </CtField>
                  <button className="mb-1 rounded p-1.5 hover:bg-accent" onClick={() => set({ cuts: spec.cuts.filter((_, j) => j !== i) })}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <div key={i} className="flex items-center gap-2 text-xs">
                  Phần cắt {c.type}
                  <button className="rounded p-1 hover:bg-accent" onClick={() => set({ cuts: spec.cuts.filter((_, j) => j !== i) })}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ),
            )}
          </section>

          <section className="space-y-2">
            <div className="flex items-center gap-2">
              <h3 className="flex-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Vùng có tên</h3>
              <CtButton size="sm" disabled={!!drawing} onClick={() => setDrawing({ id: null, points: [] })}>
                <PenLine className="h-3.5 w-3.5" /> Vẽ vùng
              </CtButton>
            </div>
            <p className="text-[11px] text-muted-foreground">Một layer “Phủ vùng” tô hoa văn / màu vào đúng vùng (ống quần, cạp, nền). Vẽ: bấm từng điểm trên tờ in bên phải rồi bấm Xong.</p>
            {spec.zones.map((z, i) => (
              <div key={z.id} className="flex items-center gap-2">
                <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: ZONE_COLOURS[i % ZONE_COLOURS.length] }} />
                <CtInput value={z.name} onChange={(e) => zoneOf(z, { name: e.target.value })} />
                <span className="w-14 shrink-0 truncate text-[10px] text-muted-foreground" title={`id: ${z.id}`}>
                  {z.id}
                </span>
                <button className="rounded p-1 hover:bg-accent" title="Vẽ lại" disabled={!!drawing} onClick={() => setDrawing({ id: z.id, points: [] })}>
                  <PenLine className="h-3.5 w-3.5" />
                </button>
                <button className="rounded p-1 hover:bg-accent" title="Xoá vùng" onClick={() => set({ zones: spec.zones.filter((x) => x.id !== z.id) })}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </section>

          <section className="space-y-2">
            <div className="flex items-center gap-2">
              <h3 className="flex-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Cỡ (S…4XL)</h3>
              <CtButton size="sm" onClick={() => set({ sizes: [...spec.sizes, { id: newId().slice(0, 8), name: `Cỡ ${spec.sizes.length + 1}`, width: spec.width, height: spec.height }] })}>
                <Plus className="h-3.5 w-3.5" /> Cỡ
              </CtButton>
            </div>
            <p className="text-[11px] text-muted-foreground">Mỗi cỡ một tờ in; vùng tự co giãn theo tỉ lệ tờ (tên cỡ trùng tên size trên Shopify thì file in đúng cỡ khách chọn).</p>
            {spec.sizes.map((s, i) => (
              <div key={s.id} className="grid grid-cols-[1fr_90px_90px_auto_auto] items-center gap-2">
                <CtInput value={s.name} onChange={(e) => set({ sizes: spec.sizes.map((x, j) => (j === i ? { ...s, name: e.target.value } : x)) })} />
                <CtNumber value={s.width} min={16} onChange={(width) => set({ sizes: spec.sizes.map((x, j) => (j === i ? { ...s, width } : x)) })} />
                <CtNumber value={s.height} min={16} onChange={(height) => set({ sizes: spec.sizes.map((x, j) => (j === i ? { ...s, height } : x)) })} />
                <button className={cx("rounded px-1.5 py-1 text-[10px]", sizeId === s.id ? "bg-foreground text-background" : "hover:bg-accent")} onClick={() => setSizeId(sizeId === s.id ? "" : s.id)}>
                  Xem
                </button>
                <button className="rounded p-1 hover:bg-accent" onClick={() => set({ sizes: spec.sizes.filter((_, j) => j !== i) })}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Ảnh</h3>
            <ImagePick label="Ảnh khung của xưởng (chỉ để canh, không in)" url={spec.frameUrl} busy={busy === "frameUrl"} onPick={(f) => void upload("frameUrl", f)} onClear={() => set({ frameUrl: null })} />
            <ImagePick label="Ảnh phôi trơn chụp thẳng (làm mockup)" url={spec.blankUrl} busy={busy === "blankUrl"} onPick={(f) => void upload("blankUrl", f)} onClear={() => set({ blankUrl: null, blankBox: null })} />
          </section>

          <CtField label="Ghi chú cho người thiết kế / agent">
            <CtTextarea rows={3} value={spec.notes} onChange={(e) => set({ notes: e.target.value })} />
          </CtField>
        </aside>
        <div ref={svgWrap} className="relative min-h-0 bg-muted/30 p-6">
          {drawing && (
            <div className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-xs shadow">
              Bấm từng điểm quanh vùng ({drawing.points.length} điểm)
              <CtButton size="sm" disabled={drawing.points.length === 0} onClick={() => setDrawing({ ...drawing, points: drawing.points.slice(0, -1) })}>
                <Undo2 className="h-3.5 w-3.5" />
              </CtButton>
              <CtButton size="sm" variant="primary" disabled={drawing.points.length < 3} onClick={finishZone}>
                <Check className="h-3.5 w-3.5" /> Xong
              </CtButton>
              <CtButton size="sm" onClick={() => setDrawing(null)}>
                Huỷ
              </CtButton>
            </div>
          )}
          <PrintSheet
            spec={spec}
            sizeId={sizeId || null}
            hideZones={drawing?.id ? [drawing.id] : []}
            drawing={drawing?.points}
            className={cx("h-full w-full", drawing && "cursor-crosshair")}
            onPointerDown={(e) => {
              if (!drawing) return;
              const p = at(e);
              setDrawing({ ...drawing, points: [...drawing.points, p] });
            }}
          />
        </div>
      </div>
    </div>
  );
}

function ImagePick({ label, url, busy, onPick, onClear }: { label: string; url: string | null; busy: boolean; onPick: (f: File | undefined) => void; onClear: () => void }) {
  const input = useRef<HTMLInputElement | null>(null);
  return (
    <div className="flex items-center gap-2">
      <div className="h-14 w-14 shrink-0 overflow-hidden rounded border bg-muted/40">
        {/* eslint-disable-next-line @next/next/no-img-element -- our R2 picture */}
        {url && <img src={url} alt="" className="h-full w-full object-contain" />}
      </div>
      <div className="min-w-0 flex-1 text-xs">{label}</div>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => onPick(e.target.files?.[0])} />
      <CtButton size="sm" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}
      </CtButton>
      {url && (
        <button className="rounded p-1 hover:bg-accent" onClick={onClear}>
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
