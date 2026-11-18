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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, CheckCircle2, ChevronDown, ChevronRight, Download, ExternalLink, Loader2, Plus, Save, Trash2, X } from "lucide-react";
import { CT_CONFIG } from "../../config";
import type { CtBaseProductConfig, CtBaseProductDetail, CtBaseScenesAuto, CtPriceTable, CtPrintArea } from "../../types";
import type { CtPrintTemplate } from "../../types/print";
import { ctApi } from "../../lib/api-client";
import { printApi } from "../../lib/print-api";
import { formatUsd, priceCells } from "../../lib/pricing";
import { newId } from "../../lib/geometry";
import { PriceTableEditor } from "../deploy/price-table-editor";
import { PhoiRow } from "../print/phoi-tab";
import { KhuonPreview, KhuonTab } from "../print/khuon-tab";
import { PrintSheet } from "../print/print-sheet";
import { ctConfirm } from "../dialogs";
import { BaseCutSection, BasePreviewSection } from "./base-cut-preview";
import { BaseAssemblySection } from "./base-assembly-section";
import { BaseExtraPics, BaseMockupSection } from "./base-mockup-section";
import { ZoomThumbs } from "../zoom-thumbs";
import { CHECKER_STYLE, CtButton, CtField, CtInput, CtModal, CtSelect, CtTextarea, CtTooltipProvider, cx } from "../ui";

/**
 * One block of the page. `fold` (asked 2026-11-18: "phôi set 1 lần là được"): it can be folded to its title + `summary`;
 * starts folded when `folded` (= already set up), the user's open / close is kept per browser (localStorage).
 */
function Section({ title, children, right, fold, folded = false, summary }: { title: string; children: React.ReactNode; right?: React.ReactNode; fold?: string; folded?: boolean; summary?: React.ReactNode }) {
  const key = fold ? `ct-base-fold:${fold}` : "";
  const [choice, setChoice] = useState<boolean | null>(() => {
    if (!key || typeof window === "undefined") return null;
    const v = window.localStorage.getItem(key);
    return v === null ? null : v === "1";
  });
  const closed = fold ? (choice ?? folded) : false;
  const toggle = () => {
    const next = !closed;
    setChoice(next);
    try {
      window.localStorage.setItem(key, next ? "1" : "0");
    } catch {
      // Private mode: only this visit.
    }
  };
  return (
    <section className="rounded-xl border bg-card p-4">
      <div className={cx("flex items-center gap-2", !closed && "mb-3")}>
        {fold ? (
          <button type="button" onClick={toggle} className="flex min-w-0 items-center gap-1.5 text-left" title={closed ? "Mở rộng" : "Thu gọn"} aria-expanded={!closed}>
            {closed ? <ChevronRight className="h-4 w-4 shrink-0" /> : <ChevronDown className="h-4 w-4 shrink-0" />}
            <h2 className="text-sm font-semibold">{title}</h2>
          </button>
        ) : (
          <h2 className="text-sm font-semibold">{title}</h2>
        )}
        {closed && summary && <span className="min-w-0 truncate text-xs text-foreground/75">{summary}</span>}
        {fold && closed ? (
          <button type="button" onClick={toggle} className="ml-auto shrink-0 rounded border px-2 py-0.5 text-xs font-medium hover:bg-accent">
            Mở rộng
          </button>
        ) : (
          <div className="ml-auto flex items-center gap-2">{right}</div>
        )}
      </div>
      {!closed && children}
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
  /** The khuôn picture shown big (click on the small thumb, asked 2026-11-17). */
  const [khuonView, setKhuonView] = useState(false);
  const [pbBusy, setPbBusy] = useState(false);
  /** The automatic 3 preview backgrounds (server/base-scenes.ts) while they are made. */
  const [auto, setAuto] = useState<CtBaseScenesAuto | null>(null);
  /** The preview as saved: the run's default background replaces it only when the editor has not changed it. */
  const savedPreview = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await ctApi.getBaseProduct(baseId);
      savedPreview.current = d.base.config.preview.url;
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

  // The 3 ready backgrounds, once per base, as soon as it has a phôi (a run already going — an import's — is followed).
  const hasPhoi = !!cfg && (!!cfg.preview.url || (cfg.cut.mode !== "alpha" && !!template?.spec.blanks.length));
  const autoDue = !!cfg && !cfg.scenesAuto && !cfg.previewScenes.length && hasPhoi;
  useEffect(() => {
    let off = false;
    ctApi
      .baseScenesState(baseId)
      .then((st) => {
        if (off) return;
        if (st.status === "running") setAuto(st);
        else if (autoDue) return ctApi.startBaseScenes(baseId).then((started) => void (!off && setAuto(started)));
      })
      .catch(() => undefined);
    return () => {
      off = true;
    };
  }, [baseId, autoDue]);
  const autoRunning = auto?.status === "running";
  useEffect(() => {
    if (!autoRunning) return;
    const t = window.setInterval(() => {
      void (async () => {
        const st = await ctApi.baseScenesState(baseId).catch(() => null);
        if (!st || st.status === "running") return st && setAuto(st);
        const d = await ctApi.getBaseProduct(baseId).catch(() => null);
        if (d) {
          const was = savedPreview.current;
          savedPreview.current = d.base.config.preview.url;
          setCfg((c) =>
            c ? { ...c, previewScenes: d.base.config.previewScenes, scenesAuto: d.base.config.scenesAuto, preview: c.preview.url === was ? d.base.config.preview : c.preview } : c,
          );
        }
        printApi.list().then(setTemplates).catch(() => undefined);
        setAuto(st);
      })();
    }, 5000);
    return () => window.clearInterval(t);
  }, [autoRunning, baseId]);
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
            <Link
              href={`${CT_CONFIG.homePath}?tab=bases`}
              className="rounded px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground hover:bg-accent hover:text-foreground hover:underline"
              title="Về danh sách Product base"
            >
              Product base
            </Link>
            <span className="text-xs text-muted-foreground">/</span>
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
                    <ZoomThumbs images={cfg.source.photos.map((u, i) => ({ url: u, name: `Ảnh nhà in ${i + 1}` }))} fit="contain" className="mt-2 flex gap-1.5 overflow-x-auto" thumbClassName="h-16 w-16 shrink-0" />
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

            <Section title={`Ảnh kèm sản phẩm (${cfg.mockup.sizeCharts.length}/4)`}>
              <BaseExtraPics cfg={cfg} onChange={(mockup) => patch({ mockup })} />
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
          </div>

          <div className="space-y-4">
            <Section
              fold="khuon"
              folded={!!cfg.templateId || cfg.noKhuon}
              summary={template ? `${template.name} · ${template.spec.width}×${template.spec.height}` : cfg.noKhuon ? "Không cần khuôn" : "Chưa có khuôn"}
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
                            ? cfg.templateId
                              ? "Đặt lại phôi theo mockup PSD của Merchize (giữ khuôn đang chọn)"
                              : "Đọc khuôn in + phôi từ file PSD của Merchize (merchize.com)"
                            : cfg.templateId
                              ? "Đặt lại phôi + lớp phủ theo Printbelle (giữ khuôn đang chọn)"
                              : "Tải khuôn in (Template.tif) + phôi từ Printbelle"
                      }
                    >
                      {pbBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}{" "}
                      {fulfiller === "merchize" ? (cfg.templateId ? "Phôi Merchize" : "Khuôn + phôi Merchize") : cfg.templateId ? "Phôi Printbelle" : "Khuôn + phôi Printbelle"}
                    </CtButton>
                  )}
                  <CtButton size="sm" variant="outline" onClick={() => setKhuonOpen(true)} title="Tạo khuôn mới / sửa khuôn (AI, mặt, size)">
                    Quản lý khuôn
                  </CtButton>
                </>
              }
            >
              <CtField label="Khuôn in">
                <CtSelect<string> value={cfg.templateId ?? ""} onChange={(templateId) => patch({ templateId, noKhuon: templateId ? false : cfg.noKhuon, cut: templateId && cfg.cut.mode === "none" ? { ...cfg.cut, mode: "khuon" } : cfg.cut })} options={templates.map((t) => ({ value: t.id, label: `${t.name} · ${t.spec.width}×${t.spec.height}` }))} placeholder="Chưa có khuôn (canvas = print area)" />
              </CtField>
              {template ? (
                <div className="mt-3 space-y-3">
                  <div className="flex gap-3">
                    <button type="button" onClick={() => setKhuonView(true)} title="Xem khuôn cỡ lớn" className="h-28 w-28 shrink-0 cursor-zoom-in rounded-lg border bg-muted/40 p-2 hover:border-primary">
                      <KhuonPreview spec={template.spec} className="h-full w-full" />
                    </button>
                    <div className="text-xs text-muted-foreground">
                      <div className="font-medium text-foreground">{template.name}</div>
                      <div>
                        {template.spec.width}×{template.spec.height}px · {template.spec.dpi} dpi{template.spec.widthMm ? ` · ${template.spec.widthMm}×${template.spec.heightMm} mm` : ""}
                      </div>
                      <div>{template.kind === "cut" ? "Cắt theo viền thiết kế (alpha)" : template.spec.faces.length ? `${template.spec.faces.length} mặt` : "Khuôn cố định"}</div>
                      {dirty && cfg.templateId !== detail.base.config.templateId && <div className="mt-1 text-amber-600">Lưu để đổi khuôn — mọi artwork xem trên base này và mọi sản phẩm của nó dùng khuôn mới.</div>}
                    </div>
                  </div>
                  {/* The base's own phôi photo (a fulfiller's import) wins over the khuôn's (lib/base-fit withBase): shown here
                      as the phôi trơn (2026-11-18: "đưa phôi import từ merchize qua làm phôi trơn"). */}
                  <PhoiRow
                    template={template}
                    basePhoi={cfg.preview.url ? { url: cfg.preview.url, name: fulfiller === "merchize" ? "Phôi Merchize" : fulfiller === "printbelle" ? "Phôi Printbelle" : "Phôi của base" } : null}
                    busy={phoiBusy}
                    onUpload={(f) => void phoiWork("Đang upload…", () => printApi.uploadBlank(template.id, f))}
                    onAi={() => void phoiWork("AI đang vẽ phôi (~1 phút)…", () => printApi.aiBlank(template.id, baseId))}
                    onRemove={(id) => void phoiWork("Đang xoá…", () => printApi.update(template.id, { spec: { ...template.spec, blanks: template.spec.blanks.filter((b) => b.id !== id) } }))}
                    onFirst={(id) => {
                      const pick = template.spec.blanks.find((b) => b.id === id);
                      if (pick) void phoiWork("Đang lưu…", () => printApi.update(template.id, { spec: { ...template.spec, blanks: [pick, ...template.spec.blanks.filter((b) => b.id !== id)] } }));
                    }}
                  />
                </div>
              ) : cfg.noKhuon || cfg.cut.mode === "alpha" ? (
                <div className="mt-3 flex items-center gap-3 rounded-lg border border-emerald-500/50 bg-emerald-500/10 p-3 text-xs">
                  <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <div className="flex-1">
                    <div className="font-semibold text-emerald-700 dark:text-emerald-400">{cfg.cut.mode === "alpha" ? "Cắt theo viền thiết kế — không cần khuôn" : "Đã xác nhận: không cần khuôn"}</div>
                    <div className="text-muted-foreground">Artwork tạo cho base này dùng canvas = print area đầu tiên.</div>
                  </div>
                  {cfg.noKhuon && (
                    <CtButton size="sm" variant="outline" onClick={() => patch({ noKhuon: false })} title="Base này cần khuôn — hiện lại cảnh báo. Nhớ bấm Lưu.">
                      <X className="h-3.5 w-3.5" /> Bỏ xác nhận
                    </CtButton>
                  )}
                </div>
              ) : (
                <NoKhuonWarning cfg={cfg} name={detail.base.name} fulfiller={fulfiller} onNoKhuon={() => patch({ noKhuon: true })} />
              )}
            </Section>

            <Section title="Cắt + file in" fold="cut" folded={!!cfg.templateId || cfg.noKhuon || cfg.cut.mode === "alpha"} summary={cfg.cut.mode === "alpha" ? "Cắt theo hình thiết kế" : cfg.cut.mode === "khuon" ? "Cắt theo khuôn" : "Không cắt"}>
              <BaseCutSection cfg={cfg} template={template} onChange={(cut) => patch({ cut })} />
            </Section>

            {(cfg.assembly || (template && cfg.cut.mode !== "alpha")) && (
              <Section title="Ráp mảnh (nón + thân)" fold="assembly" folded={!!cfg.assembly} summary={cfg.assembly ? "Đã ráp" : "Chưa ráp"}>
                <BaseAssemblySection
                  baseId={baseId}
                  cfg={cfg}
                  template={template}
                  dirty={dirty}
                  onDone={(_, note) => {
                    void load();
                    flash(note);
                  }}
                  onError={setError}
                />
              </Section>
            )}

            <Section title="Phôi / nền xem trước" fold="preview" folded={!!cfg.preview.url} summary={cfg.preview.url ? `Đã có nền${cfg.previewScenes.length ? ` · ${cfg.previewScenes.length} nền đã tạo` : ""}` : "Chưa có nền"}>
              <BasePreviewSection
                baseId={baseId}
                cfg={cfg}
                template={template}
                auto={auto}
                onChange={(preview) => patch({ preview })}
                onScenes={(previewScenes) => patch({ previewScenes })}
                savedAt={detail?.base.updated_at ?? ""}
                // Scenes @flexiprint drew (already saved on the server): kept, so the next Lưu does not drop them.
                onRemoteScenes={(list) => setCfg((c) => (c ? { ...c, previewScenes: [...c.previewScenes, ...list.filter((x) => !c.previewScenes.some((y) => y.id === x.id))] } : c))}
                onScene={(sc) => {
                  setCfg((c) => (c ? { ...c, previewScenes: [...c.previewScenes, sc], preview: sc.scene } : c));
                  setDirty(true);
                  flash("Đã tạo nền — bấm Lưu để dùng làm nền xem trước");
                }}
              />
            </Section>

            <Section title="Prompt mockup">
              <BaseMockupSection name={detail.base.name} cfg={cfg} template={template} onChange={(mockup) => patch({ mockup })} />
            </Section>
          </div>

          <div className="lg:col-span-2">
              <Section title={`Mockups (${mockupCount}) · ${detail.uses.length} sản phẩm`}>
                {detail.uses.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Chưa có sản phẩm nào làm trên product base này — mockup của chúng sẽ hiện ở đây.</p>
                ) : (
                  <div className="space-y-4">
                    {detail.uses.map((u) => (
                      <div key={u.id}>
                        <div className="mb-1.5 flex items-center gap-2 text-xs">
                          <Link href={`${CT_CONFIG.basePath}/${u.id}`} target="_blank" rel="noreferrer" className="truncate font-medium hover:underline">
                            {u.name}
                          </Link>
                          {u.artwork && <span className="truncate text-muted-foreground">· artwork “{u.artwork.name}”</span>}
                          {u.shopify && <span className="rounded bg-sky-500/15 px-1 text-[10px] text-sky-600">Shopify</span>}
                          <Link href={`${CT_CONFIG.basePath}/${u.id}`} target="_blank" rel="noreferrer" title="Mở sản phẩm (tab mới)" className="ml-auto text-muted-foreground hover:text-foreground" aria-label="Mở sản phẩm">
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Link>
                        </div>
                        {u.mockups.length ? (
                          <ZoomThumbs checker images={u.mockups.map((m) => ({ url: m.url, name: `${u.name} · ${m.name}` }))} className="grid grid-cols-4 gap-1.5 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 xl:grid-cols-12" />
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
        {template && (
          <CtModal open={khuonView} onOpenChange={setKhuonView} title={`${template.name} · ${template.spec.width}×${template.spec.height}px`} full keepOpenOnOutside={false}>
            <div className="flex min-h-0 flex-1 gap-4 overflow-auto">
              {(template.spec.faces.length > 1 ? template.spec.faces.map((_, i) => i) : [0]).map((i) => (
                <div key={i} className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
                  {template.spec.faces.length > 1 && <div className="text-center text-xs text-muted-foreground">{template.spec.faces[i]?.name}</div>}
                  <div className="min-h-0 flex-1 rounded-lg border p-3" style={CHECKER_STYLE}>
                    <PrintSheet spec={template.spec} faceIndex={i} className="h-full w-full" />
                  </div>
                </div>
              ))}
            </div>
          </CtModal>
        )}
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

/**
 * A base without a khuôn that nobody confirmed needs none (2026-11-16, boss: "phải làm thông báo editor thấy báo dev"):
 * why the fulfiller's file gave none (source.khuonIssue), its links, a ready message for the dev, and the confirm button.
 */
function NoKhuonWarning({ cfg, name, fulfiller, onNoKhuon }: { cfg: CtBaseProductConfig; name: string; fulfiller: "printbelle" | "merchize" | null; onNoKhuon: () => void }) {
  const [copied, setCopied] = useState(false);
  const issue = cfg.source?.khuonIssue ?? null;
  const who = fulfiller === "merchize" ? "Merchize" : "Printbelle";
  const reason = issue ?? (fulfiller ? `Chưa lấy khuôn từ ${who} — bấm “Khuôn + phôi ${who}” ở trên.` : "Chọn khuôn ở trên hoặc tạo trong Quản lý khuôn.");
  const links = (cfg.source?.links ?? []).filter((l) => /drive\.google|\.psd|\.tif/i.test(`${l.url} ${l.label}`));
  const copy = async () => {
    const text = `Base “${name}” (${cfg.fulfillment.provider} ${cfg.fulfillment.catalogId}) chưa có khuôn: ${issue ?? reason}\n${window.location.href}${links.length ? `\nFile xưởng: ${links.map((l) => l.url).join(" · ")}` : ""}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Chép tin này gửi dev:", text);
    }
  };
  return (
    <div className="mt-3 space-y-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-xs">
      <div className="flex items-center gap-1.5 font-semibold text-amber-700 dark:text-amber-400">
        <AlertTriangle className="h-4 w-4" /> Chưa có khuôn in
      </div>
      <div className="text-foreground">{reason}</div>
      {issue && <div className="text-muted-foreground">Báo dev (bấm “Chép tin báo dev” rồi gửi) để thêm cách đọc file này, hoặc làm khuôn tay ở Quản lý khuôn.</div>}
      {links.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {links.map((l) => (
            <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
              <ExternalLink className="h-3 w-3" /> {l.label}
            </a>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        {issue && (
          <CtButton size="sm" variant="outline" onClick={() => void copy()}>
            {copied ? "Đã chép" : "Chép tin báo dev"}
          </CtButton>
        )}
        <CtButton size="sm" variant="outline" onClick={onNoKhuon} title="Loại sản phẩm này không cần khuôn (vd. búp bê): artwork dùng canvas = print area. Nhớ bấm Lưu.">
          <CheckCircle2 className="h-3.5 w-3.5" /> Xác nhận không cần khuôn
        </CtButton>
      </div>
    </div>
  );
}
