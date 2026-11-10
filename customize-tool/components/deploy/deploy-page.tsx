"use client";

/**
 * Deploy sản phẩm (/products/:id/deploy) — the editor's "Deploy" button.
 *
 * One click: the saved design is published as the next storefront template, then the Shopify product is
 * created / updated (server/shopify.ts): title, description, status, the chosen price table as options + priced
 * variants (Size × Pack), the metafields flexi2-product.liquid reads, and the chosen mockups as product images.
 *
 * Also lists what the customer will be asked (lib/option-audit.ts), so a field without a label or an empty custom
 * layer is caught before it is live.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, Check, CheckCircle2, ExternalLink, Info, Link2, Loader2, Pencil, Plus, Rocket, Star, X } from "lucide-react";
import { CT_CONFIG } from "../../config";
import type {
  CtBaseProductRow,
  CtAsset,
  CtDeployResponse,
  CtPriceTable,
  CtProductBundle,
  CtShopifyCollection,
  CtShopifyCollectionRule,
  CtShopifyInfo,
  CtShopifyProductSummary,
  CtShopifyStatus,
  CtTemplate,
} from "../../types";
import { ctApi } from "../../lib/api-client";
import { buildTemplate } from "../../lib/template";
import { normalizeRegion } from "../../lib/design";
import { isAiStyleRef } from "../../lib/photo-styles";
import { suggestCollections } from "../../lib/collections";
import { defaultDeployMedia, productMockups } from "../../lib/deploy-media";
import { auditOptions, type CtAuditLevel } from "../../lib/option-audit";
import { formatUsd, priceCell, priceCells, priceTableFor, priceTableProblems, usesPacks, usesSizes } from "../../lib/pricing";
import { CHECKER_STYLE, CtButton, CtCheckbox, CtField, CtInput, CtSelect, CtTextarea, cx } from "../ui";
import { PriceTableEditor } from "./price-table-editor";
import { ContentAgent } from "./content-agent";
import { ImportStatus } from "../char/import-status";

const STATUS_OPTIONS: Array<{ value: CtShopifyStatus; label: string }> = [
  { value: "ACTIVE", label: "Active — bán ngay" },
  { value: "DRAFT", label: "Draft — ẩn khỏi store" },
  { value: "ARCHIVED", label: "Archived" },
];

interface Form {
  title: string;
  descriptionHtml: string;
  status: CtShopifyStatus;
  vendor: string;
  productType: string;
  tags: string;
}

export function DeployPage({ productId }: { productId: string }) {
  const [bundle, setBundle] = useState<CtProductBundle | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [info, setInfo] = useState<CtShopifyInfo | null>(null);
  const [tables, setTables] = useState<CtPriceTable[]>([]);
  const [tableId, setTableId] = useState<string>("");
  /** The product's base product: its price table is the one deployed, not picked here. */
  const [base, setBase] = useState<CtBaseProductRow | null>(null);
  const [editing, setEditing] = useState<CtPriceTable | "new" | null>(null);
  const [form, setForm] = useState<Form>({ title: "", descriptionHtml: "", status: "ACTIVE", vendor: "", productType: "", tags: "" });
  const [media, setMedia] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CtDeployResponse | null>(null);
  const [collections, setCollections] = useState<CtShopifyCollection[]>([]);
  /** Collections the product joins (badges); `primary` = the breadcrumb's. */
  const [picked, setPicked] = useState<string[]>([]);
  const [primary, setPrimary] = useState<string | null>(null);
  // "Phôi AI có ảnh khách" (2026-11-10): off by default, stored on the product at deploy.
  const [customerPhoi, setCustomerPhoi] = useState(false);

  const fill = useCallback((p: CtShopifyProductSummary | null, fallbackTitle: string) => {
    setForm({
      title: p?.title ?? fallbackTitle,
      descriptionHtml: p?.descriptionHtml ?? "",
      status: p?.status ?? "ACTIVE",
      vendor: p?.vendor ?? "",
      productType: p?.productType ?? "",
      tags: (p?.tags ?? []).join(", "),
    });
    setPicked(p?.collectionIds ?? []);
    setPrimary(p?.primaryCollectionId ?? p?.collectionIds[0] ?? null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      ctApi.getBundle(productId),
      ctApi.listPriceTables().catch(() => [] as CtPriceTable[]),
      ctApi.shopifyInfo(productId).catch((e: Error) => ({ configured: true, shop: null, product: null, error: e.message })),
      ctApi.listCollections().catch(() => [] as CtShopifyCollection[]),
      ctApi.listBaseProducts().catch(() => [] as CtBaseProductRow[]),
    ])
      .then(([b, list, shop, cols, bases]) => {
        if (cancelled) return;
        setBundle(b);
        setCustomerPhoi(b.product.config?.customerPhoi === true);
        setTables(list);
        setInfo(shop);
        setCollections(cols);
        const link = b.product.shopify ?? null;
        // A product's base product owns its variants + prices (2026-11-07); an older product: the table it was deployed
        // with, else the one of its material (never just the newest — 2026-10-30).
        const own = bases.find((x) => x.id === b.product.base_product_id) ?? null;
        setBase(own);
        setTableId(
          own?.config.priceTableId ??
            (link?.priceTableId && list.some((t) => t.id === link.priceTableId) ? link.priceTableId : (priceTableFor(list, b.product.config?.material?.id ?? "")?.id ?? "")),
        );
        fill(shop.product, link?.title ?? b.product.name);
        if (!shop.product && own) setForm((f) => ({ ...f, productType: f.productType || own.config.productType, descriptionHtml: f.descriptionHtml || own.config.description }));
        // Not on Shopify yet: it starts in the collections that fit it (no twin collections — 2026-10-30).
        if (!shop.product) {
          const fit = suggestCollections(cols, { title: link?.title ?? b.product.name });
          if (fit.length) {
            setPicked(fit.map((c) => c.id));
            setPrimary(fit[0].id);
          }
        }
        const pictures = productMockups(b.assets, b.product.id);
        const known = link ? Object.keys(link.media).filter((id) => pictures.some((a) => a.id === id)) : [];
        setMedia(known.length ? known : defaultDeployMedia(pictures));
      })
      .catch((e: Error) => !cancelled && setLoadError(e.message));
    return () => {
      cancelled = true;
    };
  }, [productId, fill]);

  const template = useMemo((): { tpl: CtTemplate | null; error: string | null } => {
    if (!bundle) return { tpl: null, error: null };
    try {
      return {
        tpl: buildTemplate({ product: bundle.product, assets: bundle.assets, regions: bundle.regions, items: bundle.items, version: (bundle.product.published_version ?? 0) + 1, publishedAt: new Date().toISOString() }),
        error: null,
      };
    } catch (e) {
      return { tpl: null, error: e instanceof Error ? e.message : "Không dựng được template" };
    }
  }, [bundle]);
  const audit = useMemo(() => (template.tpl ? auditOptions(template.tpl) : null), [template.tpl]);
  // The tick is only for products where the customer uploads a photo that an AI style redraws (the 2-step generation).
  const aiPhoto = useMemo(
    () => (bundle?.regions ?? []).map(normalizeRegion).some((r) => r.kind === "photo" && r.config.photo.styles.some(isAiStyleRef)),
    [bundle],
  );

  const table = tables.find((t) => t.id === tableId) ?? null;
  const problems = table ? priceTableProblems(table.config) : [];
  const pictures = useMemo(() => (bundle ? productMockups(bundle.assets, bundle.product.id) : []), [bundle]);

  if (loadError) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3">
        <p className="text-sm text-destructive">{loadError}</p>
        <Link href={CT_CONFIG.basePath} className="text-sm underline">
          Quay lại danh sách
        </Link>
      </div>
    );
  }
  if (!bundle) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  const product = bundle.product;
  const link = product.shopify ?? null;
  const linked = info?.product ?? null;
  const canDeploy = Boolean(table && !problems.length && template.tpl && form.title.trim() && info?.configured !== false);

  const deploy = async () => {
    if (!table) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const r = await ctApi.deploy(product.id, {
        priceTableId: table.id,
        title: form.title.trim(),
        descriptionHtml: form.descriptionHtml,
        status: form.status,
        vendor: form.vendor,
        productType: form.productType,
        tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean),
        mediaAssetIds: media,
        // Always the linked product, or a new one: deploying onto another existing product was dropped (2026-11-03).
        shopifyProductId: null,
        collectionIds: picked,
        primaryCollectionId: primary && picked.includes(primary) ? primary : (picked[0] ?? null),
        ...(aiPhoto ? { customerPhoi } : {}),
      });
      setResult(r);
      setBundle({ ...bundle, product: r.product });
      setInfo(await ctApi.shopifyInfo(product.id).catch(() => info));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Deploy thất bại");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b bg-card/80 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:px-6">
          <Link href={`${CT_CONFIG.basePath}/${product.id}`} className="rounded p-1.5 hover:bg-accent" aria-label="Về editor">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold">{product.name}</h1>
            <div className="text-[11px] text-muted-foreground">{link ? `Deploy lần cuối ${new Date(link.deployedAt).toLocaleString("vi-VN")}` : "Chưa deploy"}</div>
          </div>
          <span className="ml-auto" />
          <ImportStatus />
          <CtButton variant="primary" onClick={() => void deploy()} disabled={!canDeploy || running}>
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
            {link ? "Deploy cập nhật" : "Deploy lên Shopify"}
          </CtButton>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-5 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div className="space-y-5">
          {(error || result) && <ResultBox error={error} result={result} />}

          {/* Shopify product */}
          <Card title="Sản phẩm Shopify">
            {info?.configured === false ? (
              <Notice level="warn" text="Chưa cấu hình Shopify trên server (SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET)." />
            ) : info?.error ? (
              <Notice level="warn" text={info.error} />
            ) : null}
            <div className="flex items-center gap-3 rounded-md border p-2.5">
              {linked?.imageUrl ? (
                <img src={linked.imageUrl} alt="" className="h-12 w-12 rounded object-cover" />
              ) : (
                <div className="flex h-12 w-12 items-center justify-center rounded bg-muted text-muted-foreground">
                  <Link2 className="h-5 w-5" />
                </div>
              )}
              <div className="min-w-0 flex-1 text-sm">
                {linked ? (
                  <>
                    <div className="truncate font-medium">{linked.title}</div>
                    {linked.storeUrl && (
                      <a href={linked.storeUrl} target="_blank" rel="noreferrer" className="block truncate text-xs text-sky-500 hover:underline">
                        {linked.storeUrl}
                      </a>
                    )}
                    {link?.adminUrl && (
                      <a href={link.adminUrl} target="_blank" rel="noreferrer" className="block truncate text-xs text-muted-foreground hover:text-foreground hover:underline">
                        {link.adminUrl}
                      </a>
                    )}
                  </>
                ) : (
                  <>
                    <div className="font-medium">{link ? "Sản phẩm Shopify cũ không còn" : "Chưa có trên Shopify"}</div>
                    <div className="text-[11px] text-muted-foreground">Deploy sẽ tạo sản phẩm mới{info?.shop ? ` trên ${info.shop.domain}` : ""}.</div>
                  </>
                )}
              </div>
            </div>

            <div className="grid gap-3">
              {audit && (
                <ContentAgent
                  productId={product.id}
                  productName={product.name}
                  title={form.title}
                  descriptionHtml={form.descriptionHtml}
                  facts={[
                    ...audit.versions.flatMap((v) => (audit.versions.length > 1 ? [`Version "${v.name}": ${v.fields.join("; ") || "no customer field"}`] : v.fields)),
                    ...audit.lines.filter((l) => l.level === "ok").map((l) => l.text),
                    ...(table ? [`Price table: ${priceFacts(table)}`] : []),
                    ...(form.productType ? [`Product type: ${form.productType}`] : []),
                  ]}
                  imageUrls={media.map((id) => pictures.find((a) => a.id === id)?.url ?? "").filter(Boolean)}
                  onUse={(c) => setForm((f) => ({ ...f, title: c.title, descriptionHtml: c.descriptionHtml }))}
                />
              )}
              <CtField label="Tên sản phẩm">
                <CtInput value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="New Driver Custom State Car Plate Ornament" />
              </CtField>
              <CtField label="Mô tả (HTML)">
                <CtTextarea rows={5} value={form.descriptionHtml} onChange={(e) => setForm({ ...form, descriptionHtml: e.target.value })} placeholder="<p>Personalized ornament…</p>" />
              </CtField>
              <div className="grid gap-3 sm:grid-cols-3">
                <CtField label="Trạng thái">
                  <CtSelect<CtShopifyStatus> value={form.status} onChange={(status) => setForm({ ...form, status })} options={STATUS_OPTIONS} />
                </CtField>
                <CtField label="Vendor">
                  <CtInput value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} placeholder={info?.shop?.name ?? ""} />
                </CtField>
                <CtField label="Loại sản phẩm (product type)">
                  <CtInput value={form.productType} onChange={(e) => setForm({ ...form, productType: e.target.value })} placeholder="Ornament" />
                </CtField>
              </div>
              <CollectionPicker
                collections={collections}
                picked={picked}
                primary={primary}
                onChange={(ids, p) => {
                  setPicked(ids);
                  setPrimary(p);
                }}
                onCreated={(c) => setCollections((list) => [...list, c].sort((a, b) => a.title.localeCompare(b.title)))}
              />
              <CtField label="Tags" hint="Cách nhau bằng dấu phẩy">
                <CtInput value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="personalized, christmas" />
              </CtField>
            </div>
          </Card>

          {/* Images */}
          <Card title={`Ảnh sản phẩm (${media.length})`} hint="Mockup đã lưu của sản phẩm (tab Mockups), theo thứ tự chọn — ảnh 1 là ảnh chính. Bỏ chọn hết = giữ nguyên ảnh đang có trên Shopify.">
            {pictures.length === 0 ? (
              <p className="text-xs text-muted-foreground">Chưa có mockup — tạo ở tab Mockups trong editor. Không có ảnh, trang sản phẩm mở thẳng thiết kế live.</p>
            ) : (
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                {pictures.map((a) => (
                  <MediaTile key={a.id} asset={a} index={media.indexOf(a.id)} onToggle={() => setMedia((m) => (m.includes(a.id) ? m.filter((x) => x !== a.id) : [...m, a.id]))} />
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          {/* Price table */}
          <Card title="Bảng giá">
            {base ? (
              <p className="text-xs text-muted-foreground">
                Giá + biến thể theo product base{" "}
                <a href={`/base-products/${base.id}`} target="_blank" rel="noreferrer" className="font-medium text-foreground underline">
                  {base.name}
                </a>{" "}
                — đổi giá ở đó.
              </p>
            ) : (
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <CtField label="Chọn bảng giá">
                  <CtSelect
                    value={tableId}
                    onChange={setTableId}
                    placeholder={tables.length ? "Chọn bảng giá…" : "Chưa có bảng giá — tạo mới"}
                    options={tables.map((t) => ({ value: t.id, label: t.name }))}
                  />
                </CtField>
              </div>
              <CtButton size="sm" onClick={() => table && setEditing(table)} disabled={!table}>
                <Pencil className="h-3.5 w-3.5" /> Sửa
              </CtButton>
              <CtButton size="sm" variant="primary" onClick={() => setEditing("new")}>
                <Plus className="h-3.5 w-3.5" /> Tạo bảng giá
              </CtButton>
            </div>
            )}
            {table ? <PriceSummary table={table} /> : <p className="text-xs text-muted-foreground">Deploy cần 1 bảng giá: Size × Pack, mỗi ô là 1 variant Shopify có giá.</p>}
            {problems.length > 0 && <Notice level="warn" text={problems.join(" ")} />}
          </Card>

          {aiPhoto && (
            <Card title="Ảnh khách upload">
              <CtCheckbox
                checked={customerPhoi}
                onChange={setCustomerPhoi}
                label="Phôi AI có ảnh khách"
                hint="Bật: sau khi AI vẽ ảnh khách theo style, server vẽ lại phôi (acrylic thật) có ảnh khách — trông thật hơn nhưng khách chờ thêm ~1 phút. Tắt: ảnh khách đặt lên ảnh phôi của version (nhanh, ~30 s). Có hiệu lực sau khi bấm Deploy."
              />
              {customerPhoi && !(template.tpl?.config.versionPhoi.length ?? 0) && (
                <Notice level="warn" text="Sản phẩm chưa có phôi AI theo version trên base này — tick không có tác dụng." />
              )}
            </Card>
          )}

          {/* Customer options */}
          <Card title="Option cho khách (kiểm tra trước deploy)">
            {template.error && <Notice level="warn" text={template.error} />}
            {audit && (
              <>
                <div className="space-y-2">
                  {audit.versions.map((v, i) => (
                    <div key={i} className="rounded-md border p-2 text-xs">
                      <div className="mb-1 font-medium">
                        {audit.versions.length > 1 ? `Version “${v.name}”` : "Trang sản phẩm"}
                      </div>
                      {v.fields.length ? (
                        <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
                          {v.fields.map((f, k) => (
                            <li key={k}>{f}</li>
                          ))}
                        </ul>
                      ) : (
                        <div className="text-muted-foreground">Không có trường cho khách.</div>
                      )}
                    </div>
                  ))}
                </div>
                {/* Only what needs a look before deploying (the ok / info lines were noise, 2026-11-03). */}
                {audit.lines.some((l) => l.level === "warn") && (
                  <div className="space-y-1">
                    {audit.lines
                      .filter((l) => l.level === "warn")
                      .map((l, i) => (
                        <Notice key={i} level={l.level} text={l.text} />
                      ))}
                  </div>
                )}
              </>
            )}
          </Card>
        </div>
      </main>

      {editing && (
        <PriceTableEditor
          table={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(t) => {
            setTables((list) => [t, ...list.filter((x) => x.id !== t.id)]);
            setTableId(t.id);
            setEditing(null);
          }}
          onDeleted={(id) => {
            setTables((list) => list.filter((x) => x.id !== id));
            if (tableId === id) setTableId("");
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function priceFacts(t: CtPriceTable): string {
  const cells = priceCells(t.config);
  const lo = Math.min(...cells.map((c) => c.unit));
  const hi = Math.max(...cells.map((c) => c.unit));
  const parts = [usesSizes(t.config) ? `${t.config.sizeLabel}: ${t.config.sizes.map((s) => s.label).join(", ")}` : "", usesPacks(t.config) ? `${t.config.packLabel}: ${t.config.packs.map((p) => p.label).join(", ")} (each piece a different design)` : ""];
  return `${parts.filter(Boolean).join("; ")}; ${formatUsd(lo)}–${formatUsd(hi)} per piece`;
}

/**
 * Collections: pick from the shop's list (or make one); each becomes a badge. Click a badge = the breadcrumb's
 * collection on the product page (★). Smart collections fill themselves by rules, so they can't be picked.
 */
/** A smart collection's rules in short: "tag family", "type Ornament / Christmas Ornament". */
function ruleText(c: CtShopifyCollection): string {
  const eq = c.rules.filter((r) => r.relation === "EQUALS");
  if (!eq.length) return "theo luật";
  const col = (r: CtShopifyCollectionRule) => (r.column === "TAG" ? "tag" : r.column === "TYPE" ? "loại" : r.column.toLowerCase());
  return `${col(eq[0])} ${eq.map((r) => r.condition).join(c.disjunctive ? " / " : " + ")}`;
}

function CollectionPicker({
  collections,
  picked,
  primary,
  onChange,
  onCreated,
}: {
  collections: CtShopifyCollection[];
  picked: string[];
  primary: string | null;
  onChange: (ids: string[], primary: string | null) => void;
  onCreated: (c: CtShopifyCollection) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const byId = new Map(collections.map((c) => [c.id, c]));
  const first = primary && picked.includes(primary) ? primary : (picked[0] ?? null);
  const add = (id: string) => {
    if (!id || picked.includes(id)) return;
    onChange([...picked, id], first ?? id);
  };
  const create = async () => {
    const t = name.trim();
    if (!t) return;
    setBusy(true);
    setError(null);
    try {
      const c = await ctApi.createCollection(t);
      onCreated(c);
      add(c.id);
      setName("");
      setCreating(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tạo được collection");
    } finally {
      setBusy(false);
    }
  };
  return (
    <CtField
      label="Collections"
      hint="Bấm 1 badge để chọn collection hiện trên breadcrumb (★). Collection tự động: deploy tự gắn tag / loại sản phẩm theo luật của nó. Tạo mới chỉ khi không có cái nào hợp — trùng tên thì dùng lại cái cũ."
    >
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <CtSelect
            value=""
            onChange={add}
            placeholder={collections.length ? "Thêm vào collection…" : "Store chưa có collection — tạo mới"}
            options={collections.filter((c) => !picked.includes(c.id)).map((c) => ({ value: c.id, label: c.smart ? `${c.title} (tự động — ${ruleText(c)})` : c.title }))}
          />
        </div>
        <CtButton size="sm" variant="outline" onClick={() => setCreating((v) => !v)}>
          <Plus className="h-3.5 w-3.5" /> Tạo collection
        </CtButton>
      </div>
      {creating && (
        <div className="flex items-center gap-2">
          <CtInput className="h-8" value={name} onChange={(e) => setName(e.target.value)} placeholder="vd. Christmas Ornaments" autoFocus onKeyDown={(e) => e.key === "Enter" && void create()} />
          <CtButton size="sm" variant="primary" onClick={() => void create()} disabled={busy || !name.trim()}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Tạo
          </CtButton>
        </div>
      )}
      {error && <div className="text-[11px] text-destructive">{error}</div>}
      {picked.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {picked.map((id) => {
            const c = byId.get(id);
            const star = id === first;
            return (
              <span
                key={id}
                className={cx(
                  "inline-flex cursor-pointer items-center gap-1 rounded-full border px-2.5 py-1 text-xs",
                  star ? "border-amber-500 bg-amber-500/15 text-amber-700 dark:text-amber-300" : "hover:bg-accent",
                )}
                title={star ? "Đang hiện trên breadcrumb" : "Bấm để hiện collection này trên breadcrumb"}
                onClick={() => onChange(picked, id)}
              >
                {star && <Star className="h-3 w-3 fill-current" />}
                {c?.title ?? "(collection đã xoá)"}
                <button
                  className="rounded-full p-0.5 hover:bg-black/10"
                  aria-label="Bỏ collection"
                  onClick={(e) => {
                    e.stopPropagation();
                    const rest = picked.filter((x) => x !== id);
                    onChange(rest, star ? (rest[0] ?? null) : first);
                  }}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}
    </CtField>
  );
}

function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Notice({ level, text }: { level: CtAuditLevel | "error"; text: string }) {
  const Icon = level === "ok" ? CheckCircle2 : level === "info" ? Info : AlertTriangle;
  return (
    <div
      className={cx(
        "flex items-start gap-1.5 rounded-md px-2 py-1.5 text-xs",
        level === "ok" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
        level === "info" && "bg-sky-500/10 text-sky-700 dark:text-sky-400",
        level === "warn" && "bg-amber-500/10 text-amber-700 dark:text-amber-400",
        level === "error" && "bg-destructive/10 text-destructive",
      )}
    >
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{text}</span>
    </div>
  );
}

function ResultBox({ error, result }: { error: string | null; result: CtDeployResponse | null }) {
  if (error) return <Notice level="error" text={error} />;
  if (!result) return null;
  return (
    <div className="space-y-2 rounded-xl border border-emerald-500/50 bg-emerald-500/10 p-3 text-sm">
      <div className="flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-400">
        <Check className="h-4 w-4" /> Đã deploy: template v{result.publish.version} · Shopify {result.shopify.status.toLowerCase()}
      </div>
      <div className="flex flex-wrap gap-2">
        <a href={result.shopify.adminUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md border bg-background px-2.5 py-1 text-xs hover:bg-accent">
          <ExternalLink className="h-3.5 w-3.5" /> Shopify admin
        </a>
        <a href={result.shopify.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md border bg-background px-2.5 py-1 text-xs hover:bg-accent">
          <ExternalLink className="h-3.5 w-3.5" /> Trang sản phẩm
        </a>
        {result.previewUrl && (
          <a href={result.previewUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md border bg-background px-2.5 py-1 text-xs hover:bg-accent">
            <ExternalLink className="h-3.5 w-3.5" /> Xem trước (qua mật khẩu store)
          </a>
        )}
      </div>
      {result.warnings.map((w, i) => (
        <Notice key={i} level="warn" text={w} />
      ))}
    </div>
  );
}

function PriceSummary({ table }: { table: CtPriceTable }) {
  const cfg = table.config;
  const cells = priceCells(cfg);
  const sizes = usesSizes(cfg) ? cfg.sizes : [];
  const packs = usesPacks(cfg) ? cfg.packs : [];
  return (
    <div className="space-y-2 text-xs">
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full">
          <thead className="bg-muted/40">
            <tr>
              <th className="px-2 py-1 text-left font-medium">{sizes.length ? cfg.sizeLabel : ""}</th>
              {(packs.length ? packs : [null]).map((p, i) => (
                <th key={p?.id ?? i} className="px-2 py-1 text-left font-medium">
                  {p?.label ?? "Giá"}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(sizes.length ? sizes : [null]).map((s, si) => (
              <tr key={s?.id ?? si} className="border-t">
                <td className="whitespace-nowrap px-2 py-1 font-medium">{s?.label ?? ""}</td>
                {(packs.length ? packs : [null]).map((p, pi) => {
                  const c = priceCell(cfg, s ?? cfg.sizes[0] ?? null, p ?? cfg.packs[0] ?? null);
                  return (
                    <td key={p?.id ?? pi} className="whitespace-nowrap px-2 py-1">
                      <b>{formatUsd(c.price)}</b>
                      {c.qty > 1 && <span className="ml-1 text-muted-foreground">{formatUsd(c.unit)}/pc</span>}
                      {c.compareAt !== null && <s className="ml-1 text-muted-foreground">{formatUsd(c.compareAt)}</s>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MediaTile({ asset, index, onToggle }: { asset: CtAsset; index: number; onToggle: () => void }) {
  const on = index >= 0;
  return (
    <button className={cx("relative aspect-square overflow-hidden rounded-md border", on ? "ring-2 ring-sky-500" : "opacity-60 hover:opacity-100")} style={CHECKER_STYLE} onClick={onToggle} title={asset.name}>
      <img src={asset.url} alt="" className="h-full w-full object-cover" loading="lazy" />
      {on && <span className="absolute left-1 top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-sky-500 px-1 text-[11px] font-bold text-white">{index + 1}</span>}
    </button>
  );
}


