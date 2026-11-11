"use client";

/**
 * /base-products/:id — one product base (asked 2026-11-07, Teeinblue's "Edit product"):
 *
 *   Thông tin        name (= kind of product), Shopify product type, description, fulfiller + catalog id (no material
 *                    field since 2026-11-10: the khuôn + phôi say what the piece is; config.material stays for old data)
 *   Khuôn in + phôi  the piece an artwork is drawn for (ct_print_templates) and its blank photos
 *   Cắt + file in    fixed khuôn / along the art / flat, the silhouette (2026-11-08, base-cut-preview.tsx)
 *   Phôi / nền       the preview photo (a phôi, or a background for the acrylic plate made from the design)
 *   Print areas      the file(s) the factory takes (name, px, dpi)
 *   Biến thể + giá   the fulfiller's variants + base cost (imported bases, read-only) and the Notion price table (sizes ×
 *                    packs): edited here, every product on this base deploys with it
 *   Mockups          none of its own: the mockups of every product made on it, by product
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Download, ExternalLink, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { CT_CONFIG } from "../../config";
import type { CtBaseProductConfig, CtBaseProductDetail, CtPriceTable, CtPrintArea } from "../../types";
import type { CtPrintTemplate } from "../../types/print";
import { ctApi } from "../../lib/api-client";
import { printApi } from "../../lib/print-api";
import { formatUsd, priceCells } from "../../lib/pricing";
import { newId } from "../../lib/geometry";
import { PriceTableEditor } from "../deploy/price-table-editor";
import { PhoiRow } from "../print/phoi-tab";
import { KhuonPreview, KhuonTab } from "../print/khuon-tab";
import { ctConfirm } from "../dialogs";
import { BaseCutSection, BasePreviewSection } from "./base-cut-preview";
import { CHECKER_STYLE, CtButton, CtField, CtInput, CtModal, CtSelect, CtTextarea, CtTooltipProvider } from "../ui";

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="rounded-xl border bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <div className="ml-auto flex items-center gap-2">{right}</div>
      </div>
      {children}
    </section>
  );
}

export function BaseProductView({ baseId }: { baseId: string }) {
  const [detail, setDetail] = useState<CtBaseProductDetail | null>(null);
  const [name, setName] = useState("");
  const [cfg, setCfg] = useState<CtBaseProductConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [templates, setTemplates] = useState<CtPrintTemplate[]>([]);
  const [tables, setTables] = useState<CtPriceTable[]>([]);
  const [editTable, setEditTable] = useState(false);
  const [phoiBusy, setPhoiBusy] = useState<string | null>(null);
  /** The khuôn editor (draw / change a khuôn by AI, faces, sizes) — what the old Thư viện → Khuôn in tab was. */
  const [khuonOpen, setKhuonOpen] = useState(false);
  const [pbBusy, setPbBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await ctApi.getBaseProduct(baseId);
      setDetail(d);
      setName(d.base.name);
      setCfg(d.base.config);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tải được");
    }
  }, [baseId]);
  useEffect(() => {
    void load();
    printApi.list().then(setTemplates).catch(() => undefined);
    ctApi.listPriceTables().then(setTables).catch(() => undefined);
  }, [load]);

  const patch = (p: Partial<CtBaseProductConfig>) => {
    setCfg((c) => (c ? { ...c, ...p } : c));
    setDirty(true);
  };
  const flash = (t: string) => {
    setNotice(t);
    window.setTimeout(() => setNotice(null), 3000);
  };

  const save = async () => {
    if (!cfg) return;
    setSaving(true);
    setError(null);
    try {
      const r = await ctApi.updateBaseProduct(baseId, { name: name.trim() || detail?.base.name || "Product base", config: cfg });
      await load();
      flash(r.reapplied ? `Đã lưu · ${r.reapplied} sản phẩm đã cập nhật khuôn / phôi theo base` : "Đã lưu");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không lưu được");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!(await ctConfirm({ title: `Xoá product base “${name}”?`, message: "Chỉ xoá được khi không còn sản phẩm nào dùng nó. Khuôn in và bảng giá giữ nguyên.", tone: "danger", confirmLabel: "Xoá" }))) return;
    try {
      await ctApi.deleteBaseProduct(baseId);
      window.location.href = `${CT_CONFIG.homePath}?tab=bases`;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không xoá được");
    }
  };

  const template = useMemo(() => templates.find((t) => t.id === cfg?.templateId) ?? null, [templates, cfg?.templateId]);
  const fulfiller = !cfg ? null : cfg.source?.provider ?? (/^prin?t?belle/i.test(cfg.fulfillment.provider) ? "printbelle" : /^merchize/i.test(cfg.fulfillment.provider) ? "merchize" : null);
  /** Printbelle: its khuôn (Template.tif, if the base has none) + its phôi with the overlay · Merchize: its PSD links. */
  const refreshFulfiller = async () => {
    setPbBusy(true);
    setError(null);
    try {
      const r = await ctApi.refreshFulfillerBase(baseId);
      await load();
      setTemplates(await printApi.list());
      flash(`${r.note}${r.phoi ? " · phôi Printbelle" : ""}${r.reapplied ? ` · ${r.reapplied} sản phẩm cập nhật` : ""}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không lấy được từ Printbelle");
    } finally {
      setPbBusy(false);
    }
  };
  const table = useMemo(() => tables.find((t) => t.id === cfg?.priceTableId) ?? null, [tables, cfg?.priceTableId]);
  const cells = table ? priceCells(table.config) : [];

  const phoiWork = async (label: string, job: () => Promise<CtPrintTemplate>) => {
    setPhoiBusy(label);
    try {
      const t = await job();
      setTemplates((list) => list.map((x) => (x.id === t.id ? t : x)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lỗi");
    } finally {
      setPhoiBusy(null);
    }
  };

  const setArea = (id: string, p: Partial<CtPrintArea>) => patch({ printAreas: (cfg?.printAreas ?? []).map((a) => (a.id === id ? { ...a, ...p } : a)) });

  if (error && !detail) return <p className="p-8 text-sm text-destructive">{error}</p>;
  if (!detail || !cfg) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }
  const mockupCount = detail.uses.reduce((n, u) => n + u.mockups.length, 0);

  return (
    <CtTooltipProvider>
      <div className="min-h-screen bg-background">
        <header className="sticky top-0 z-20 border-b bg-card/80 backdrop-blur-sm">
          <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
            <Link href={`${CT_CONFIG.homePath}?tab=bases`} className="rounded p-1.5 hover:bg-accent">
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Product base</span>
            <h1 className="truncate text-lg font-semibold">{name}</h1>
            <div className="ml-auto flex items-center gap-2">
              {notice && <span className="text-xs text-muted-foreground">{notice}</span>}
              <CtButton variant="ghost" size="sm" onClick={() => void remove()} title="Xoá product base">
                <Trash2 className="h-4 w-4" />
              </CtButton>
              <CtButton variant={dirty ? "primary" : "outline"} size="sm" onClick={() => void save()} disabled={saving || !dirty}>
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} {dirty ? "Lưu" : "Đã lưu"}
              </CtButton>
            </div>
          </div>
        </header>
        <main className="mx-auto grid max-w-7xl gap-4 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:px-8">
          {error && <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive lg:col-span-2">{error}</div>}
          <div className="space-y-4">
            <Section title="Thông tin">
              <div className="grid gap-3 sm:grid-cols-2">
                <CtField label="Tên (loại sản phẩm)">
                  <CtInput
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      setDirty(true);
                    }}
                  />
                </CtField>
                <CtField label="Shopify product type">
                  <CtInput value={cfg.productType} onChange={(e) => patch({ productType: e.target.value })} placeholder="Acrylic Ornament" />
                </CtField>
                <CtField label="Fulfillment (xưởng · catalog ID)">
                  <div className="flex gap-2">
                    <CtInput value={cfg.fulfillment.provider} onChange={(e) => patch({ fulfillment: { ...cfg.fulfillment, provider: e.target.value } })} placeholder="Merchize" />
                    <CtInput value={cfg.fulfillment.catalogId} onChange={(e) => patch({ fulfillment: { ...cfg.fulfillment, catalogId: e.target.value } })} placeholder="ACORUS" />
                  </div>
                </CtField>
              </div>
              {cfg.source && (
                <div className="mt-3 rounded-md border bg-muted/30 p-2.5 text-xs text-muted-foreground">
                  <div>
                    Import từ <span className="font-medium text-foreground">{cfg.fulfillment.provider || cfg.source.provider}</span> · {cfg.source.catalogId}
                    {cfg.source.via === "teeinblue" ? (cfg.source.teeinblueId ? ` · qua Teeinblue (base #${cfg.source.teeinblueId})` : "") : " · API Printbelle"}
                    {cfg.source.importedAt && ` · ${cfg.source.importedAt.slice(0, 10)}`}
                  </div>
                  {cfg.source.photos.length > 0 && (
                    <div className="mt-2 flex gap-1.5 overflow-x-auto">
                      {cfg.source.photos.map((u) => (
                        <a key={u} href={u} target="_blank" rel="noreferrer" className="h-16 w-16 shrink-0 overflow-hidden rounded border bg-white">
                          {/* eslint-disable-next-line @next/next/no-img-element -- our R2 copy of the fulfiller's photo */}
                          <img src={u} alt="" className="h-full w-full object-contain" loading="lazy" />
                        </a>
                      ))}
                    </div>
                  )}
                  {(cfg.source.links ?? []).length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                      {(cfg.source.links ?? []).map((l) => (
                        <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sky-600 hover:underline">
                          <ExternalLink className="h-3 w-3" /> {l.label}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="mt-3 space-y-3">
                <CtField label="Mô tả mặc định (sản phẩm tự viết đè khi deploy)">
                  <CtTextarea rows={4} value={cfg.description} onChange={(e) => patch({ description: e.target.value })} />
                </CtField>
                <CtField label="Ghi chú nội bộ">
                  <CtTextarea rows={2} value={cfg.notes} onChange={(e) => patch({ notes: e.target.value })} />
                </CtField>
              </div>
            </Section>

            <Section
              title="Print areas"
              right={
                <CtButton size="sm" variant="outline" onClick={() => patch({ printAreas: [...cfg.printAreas, { id: newId(), name: cfg.printAreas.length ? "Back" : "Front", width: template?.spec.width ?? 1000, height: template?.spec.height ?? 1000, dpi: template?.spec.dpi ?? 300 }] })}>
                  <Plus className="h-3.5 w-3.5" /> Print area
                </CtButton>
              }
            >
              {cfg.printAreas.length === 0 ? (
                <p className="text-xs text-muted-foreground">Chưa có print area — file in lấy đúng khổ khuôn in.</p>
              ) : (
                <table className="w-full text-xs">
                  <thead className="text-left text-[11px] text-muted-foreground">
                    <tr>
                      <th className="pb-1 font-medium">Tên</th>
                      <th className="pb-1 font-medium">Rộng px</th>
                      <th className="pb-1 font-medium">Cao px</th>
                      <th className="pb-1 font-medium">DPI</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {cfg.printAreas.map((a) => (
                      <tr key={a.id}>
                        <td className="py-0.5 pr-2">
                          <CtInput className="h-7 text-xs" value={a.name} onChange={(e) => setArea(a.id, { name: e.target.value })} />
                        </td>
                        <td className="py-0.5 pr-2">
                          <CtInput className="h-7 text-xs" inputMode="numeric" value={String(a.width)} onChange={(e) => setArea(a.id, { width: Number(e.target.value) || 0 })} />
                        </td>
                        <td className="py-0.5 pr-2">
                          <CtInput className="h-7 text-xs" inputMode="numeric" value={String(a.height)} onChange={(e) => setArea(a.id, { height: Number(e.target.value) || 0 })} />
                        </td>
                        <td className="py-0.5 pr-2">
                          <CtInput className="h-7 text-xs" inputMode="numeric" value={String(a.dpi)} onChange={(e) => setArea(a.id, { dpi: Number(e.target.value) || 0 })} />
                        </td>
                        <td>
                          <button className="rounded p-1 text-muted-foreground hover:bg-accent" onClick={() => patch({ printAreas: cfg.printAreas.filter((x) => x.id !== a.id) })} aria-label="Xoá">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {cfg.printAreas.length > 1 && <p className="mt-2 text-[11px] text-muted-foreground">Mặt thứ 2 trở đi in cùng artwork với mặt đầu.</p>}
            </Section>

            <Section
              title="Biến thể + giá"
              right={
                table && (
                  <CtButton size="sm" variant="outline" onClick={() => setEditTable(true)}>
                    Sửa bảng giá
                  </CtButton>
                )
              }
            >
              {cfg.variants.length > 0 && (
                <div className="mb-3">
                  <div className="mb-1 text-[11px] font-medium text-muted-foreground">Biến thể nhà in ({cfg.variants.length}) · giá vốn</div>
                  <div className="max-h-60 overflow-auto rounded-md border">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-muted text-left text-[11px] text-muted-foreground">
                        <tr>
                          <th className="px-2 py-1 font-medium">Size</th>
                          <th className="px-2 py-1 font-medium">Màu</th>
                          <th className="px-2 py-1 font-medium">Mã nhà in</th>
                          <th className="px-2 py-1 font-medium">Vùng in px</th>
                          <th className="px-2 py-1 text-right font-medium">Giá vốn</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cfg.variants.map((v) => (
                          <tr key={v.id} className="border-t">
                            <td className="px-2 py-1">{v.size || "—"}</td>
                            <td className="px-2 py-1">
                              <span className="inline-flex items-center gap-1">
                                {v.colorHex && <span className="inline-block h-3 w-3 rounded-sm border" style={{ background: v.colorHex }} />}
                                {v.color || "—"}
                              </span>
                            </td>
                            <td className="px-2 py-1 font-mono text-[11px]">{v.sku || "—"}</td>
                            <td className="px-2 py-1 text-muted-foreground">{v.printWidth && v.printHeight ? `${v.printWidth}×${v.printHeight}` : "—"}</td>
                            <td className="px-2 py-1 text-right font-medium">{v.cost !== null ? formatUsd(v.cost) : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              <CtField label="Bảng giá (Notion)">
                <CtSelect<string> value={cfg.priceTableId ?? ""} onChange={(priceTableId) => patch({ priceTableId })} options={tables.map((t) => ({ value: t.id, label: t.name }))} placeholder="Chọn bảng giá…" />
              </CtField>
              {table && (
                <div className="mt-3 max-h-80 overflow-auto rounded-md border">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-muted text-left text-[11px] text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1 font-medium">{table.config.sizeLabel}</th>
                        <th className="px-2 py-1 font-medium">{table.config.packLabel}</th>
                        <th className="px-2 py-1 text-right font-medium">Giá</th>
                        <th className="px-2 py-1 text-right font-medium">Giá gạch</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cells.map((c, i) => (
                        <tr key={i} className="border-t">
                          <td className="px-2 py-1">{c.size?.label || "—"}</td>
                          <td className="px-2 py-1">{c.pack?.label || "—"}</td>
                          <td className="px-2 py-1 text-right font-medium">{formatUsd(c.price)}</td>
                          <td className="px-2 py-1 text-right text-muted-foreground line-through">{c.compareAt !== null ? formatUsd(c.compareAt) : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>
          </div>

          <div className="space-y-4">
            <Section
              title="Khuôn in + phôi"
              right={
                <>
                  {fulfiller && (
                    <CtButton
                      size="sm"
                      variant="outline"
                      onClick={() => void refreshFulfiller()}
                      disabled={pbBusy || dirty}
                      title={
                        dirty
                          ? "Lưu thay đổi trước"
                          : fulfiller === "merchize"
                            ? "Tìm link khuôn + mockup (PSD) trên merchize.com"
                            : cfg.templateId
                              ? "Đặt lại phôi + lớp phủ theo Printbelle (giữ khuôn đang chọn)"
                              : "Tải khuôn in (Template.tif) + phôi từ Printbelle"
                      }
                    >
                      {pbBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}{" "}
                      {fulfiller === "merchize" ? "Link khuôn Merchize" : cfg.templateId ? "Phôi Printbelle" : "Khuôn + phôi Printbelle"}
                    </CtButton>
                  )}
                  <CtButton size="sm" variant="outline" onClick={() => setKhuonOpen(true)} title="Tạo khuôn mới / sửa khuôn (AI, mặt, size)">
                    Quản lý khuôn
                  </CtButton>
                </>
              }
            >
              <CtField label="Khuôn in">
                <CtSelect<string> value={cfg.templateId ?? ""} onChange={(templateId) => patch({ templateId, cut: templateId && cfg.cut.mode === "none" ? { ...cfg.cut, mode: "khuon" } : cfg.cut })} options={templates.map((t) => ({ value: t.id, label: `${t.name} · ${t.spec.width}×${t.spec.height}` }))} placeholder="Chưa có khuôn (canvas = print area)" />
              </CtField>
              {template ? (
                <div className="mt-3 space-y-3">
                  <div className="flex gap-3">
                    <div className="h-28 w-28 shrink-0 rounded-lg border bg-muted/40 p-2">
                      <KhuonPreview spec={template.spec} className="h-full w-full" />
                    </div>
                    <div className="text-xs text-muted-foreground">
                      <div className="font-medium text-foreground">{template.name}</div>
                      <div>
                        {template.spec.width}×{template.spec.height}px · {template.spec.dpi} dpi{template.spec.widthMm ? ` · ${template.spec.widthMm}×${template.spec.heightMm} mm` : ""}
                      </div>
                      <div>{template.kind === "cut" ? "Cắt theo viền thiết kế (alpha)" : template.spec.faces.length ? `${template.spec.faces.length} mặt` : "Khuôn cố định"}</div>
                      {dirty && cfg.templateId !== detail.base.config.templateId && <div className="mt-1 text-amber-600">Lưu để đổi khuôn — mọi artwork xem trên base này và mọi sản phẩm của nó dùng khuôn mới.</div>}
                    </div>
                  </div>
                  <PhoiRow
                    template={template}
                    busy={phoiBusy}
                    onUpload={(f) => void phoiWork("Đang upload…", () => printApi.uploadBlank(template.id, f))}
                    onAi={() => void phoiWork("AI đang vẽ phôi (~1 phút)…", () => printApi.aiBlank(template.id))}
                    onRemove={(id) => void phoiWork("Đang xoá…", () => printApi.update(template.id, { spec: { ...template.spec, blanks: template.spec.blanks.filter((b) => b.id !== id) } }))}
                    onFirst={(id) => {
                      const pick = template.spec.blanks.find((b) => b.id === id);
                      if (pick) void phoiWork("Đang lưu…", () => printApi.update(template.id, { spec: { ...template.spec, blanks: [pick, ...template.spec.blanks.filter((b) => b.id !== id)] } }));
                    }}
                  />
                </div>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">Không khuôn: artwork tạo cho base này dùng canvas = print area đầu tiên.</p>
              )}
            </Section>

            <Section title="Cắt + file in">
              <BaseCutSection cfg={cfg} template={template} onChange={(cut) => patch({ cut })} />
            </Section>

            <Section title="Phôi / nền xem trước">
              <BasePreviewSection cfg={cfg} template={template} onChange={(preview) => patch({ preview })} />
            </Section>

            <Section title={`Mockups (${mockupCount}) · ${detail.uses.length} sản phẩm`}>
              {detail.uses.length === 0 ? (
                <p className="text-xs text-muted-foreground">Chưa có sản phẩm nào làm trên product base này — mockup của chúng sẽ hiện ở đây.</p>
              ) : (
                <div className="space-y-4">
                  {detail.uses.map((u) => (
                    <div key={u.id}>
                      <div className="mb-1.5 flex items-center gap-2 text-xs">
                        <Link href={`${CT_CONFIG.basePath}/${u.id}`} className="truncate font-medium hover:underline">
                          {u.name}
                        </Link>
                        {u.artwork && <span className="truncate text-muted-foreground">· artwork “{u.artwork.name}”</span>}
                        {u.shopify && <span className="rounded bg-sky-500/15 px-1 text-[10px] text-sky-600">Shopify</span>}
                        <Link href={`${CT_CONFIG.basePath}/${u.id}`} className="ml-auto text-muted-foreground hover:text-foreground" aria-label="Mở sản phẩm">
                          <ExternalLink className="h-3.5 w-3.5" />
                        </Link>
                      </div>
                      {u.mockups.length ? (
                        <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
                          {u.mockups.map((m) => (
                            <a key={m.id} href={m.url} target="_blank" rel="noreferrer" className="aspect-square overflow-hidden rounded border" style={CHECKER_STYLE}>
                              {/* eslint-disable-next-line @next/next/no-img-element -- our R2 picture */}
                              <img src={m.url} alt={m.name} className="h-full w-full object-cover" loading="lazy" />
                            </a>
                          ))}
                        </div>
                      ) : (
                        <p className="text-[11px] text-muted-foreground">Chưa có mockup.</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Section>
          </div>
        </main>
        <CtModal
          open={khuonOpen}
          onOpenChange={(o) => {
            setKhuonOpen(o);
            if (!o) printApi.list().then(setTemplates).catch(() => undefined);
          }}
          title="Khuôn in"
          full
        >
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border">
            <KhuonTab />
          </div>
        </CtModal>
        {editTable && table && (
          <PriceTableEditor
            table={table}
            onClose={() => setEditTable(false)}
            onSaved={(t) => {
              setTables((list) => list.map((x) => (x.id === t.id ? t : x)));
              setEditTable(false);
              flash("Đã lưu bảng giá");
            }}
            onDeleted={(id) => {
              setTables((list) => list.filter((x) => x.id !== id));
              if (cfg.priceTableId === id) patch({ priceTableId: null });
              setEditTable(false);
            }}
          />
        )}
      </div>
    </CtTooltipProvider>
  );
}
