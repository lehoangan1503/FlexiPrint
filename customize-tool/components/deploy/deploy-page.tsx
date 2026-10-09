"use client";

/**
 * Deploy sản phẩm (/products/:id/deploy) — the editor's "Deploy" button.
 *
 * One click: the saved design is published as the next storefront template, then the Shopify product is
 * created / updated (server/shopify.ts): title, description, status, the chosen price table as options + priced
 * variants (Size × Pack), the metafields main-product.liquid reads, and the chosen mockups as product images.
 *
 * Also lists what the customer will be asked (lib/option-audit.ts), so a field without a label or an empty custom
 * layer is caught before it is live.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, Check, CheckCircle2, ExternalLink, Info, Link2, Loader2, Pencil, Plus, Rocket, Search, Star, X } from "lucide-react";
import { CT_CONFIG } from "../../config";
import type {
  CtAsset,
  CtDeployResponse,
  CtPriceTable,
  CtProductBundle,
  CtShopifyCollection,
  CtShopifyInfo,
  CtShopifyProductSummary,
  CtShopifyStatus,
  CtTemplate,
} from "../../types";
import { ctApi } from "../../lib/api-client";
import { buildTemplate } from "../../lib/template";
import { auditOptions, type CtAuditLevel } from "../../lib/option-audit";
import { formatUsd, priceCell, priceCells, priceTableProblems, usesPacks, usesSizes } from "../../lib/pricing";
import { CHECKER_STYLE, CtButton, CtField, CtInput, CtSelect, CtTextarea, cx } from "../ui";
import { PriceTableEditor } from "./price-table-editor";
import { ContentAgent } from "./content-agent";

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
  const [editing, setEditing] = useState<CtPriceTable | "new" | null>(null);
  const [form, setForm] = useState<Form>({ title: "", descriptionHtml: "", status: "ACTIVE", vendor: "", productType: "", tags: "" });
  const [media, setMedia] = useState<string[]>([]);
  /** Deploy onto this existing Shopify product (picked by search) instead of the linked one / a new one. */
  const [target, setTarget] = useState<CtShopifyProductSummary | null>(null);
  const [searching, setSearching] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CtDeployResponse | null>(null);
  const [collections, setCollections] = useState<CtShopifyCollection[]>([]);
  /** Collections the product joins (badges); `primary` = the breadcrumb's. */
  const [picked, setPicked] = useState<string[]>([]);
  const [primary, setPrimary] = useState<string | null>(null);

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
    ctApi
      .listCollections()
      .then(setCollections)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([ctApi.getBundle(productId), ctApi.listPriceTables().catch(() => [] as CtPriceTable[]), ctApi.shopifyInfo(productId).catch((e: Error) => ({ configured: true, shop: null, product: null, error: e.message }))])
      .then(([b, list, shop]) => {
        if (cancelled) return;
        setBundle(b);
        setTables(list);
        setInfo(shop);
        const link = b.product.shopify ?? null;
        setTableId(link?.priceTableId && list.some((t) => t.id === link.priceTableId) ? link.priceTableId : (list[0]?.id ?? ""));
        fill(shop.product, link?.title ?? b.product.name);
        const pictures = b.assets.filter((a) => a.product_id === b.product.id && a.role === "mockup");
        const known = link ? Object.keys(link.media).filter((id) => pictures.some((a) => a.id === id)) : [];
        setMedia(known.length ? known : pictures.slice(0, 8).map((a) => a.id));
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

  const table = tables.find((t) => t.id === tableId) ?? null;
  const problems = table ? priceTableProblems(table.config) : [];
  const pictures = useMemo(() => (bundle ? bundle.assets.filter((a) => a.product_id === bundle.product.id && a.role === "mockup") : []), [bundle]);

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
  const linked = target ?? info?.product ?? null;
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
        shopifyProductId: target?.id ?? null,
        collectionIds: picked,
        primaryCollectionId: primary && picked.includes(primary) ? primary : (picked[0] ?? null),
      });
      setResult(r);
      setBundle({ ...bundle, product: r.product });
      setTarget(null);
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
            <h1 className="truncate text-base font-semibold">Deploy sản phẩm — {product.name}</h1>
            <div className="text-[11px] text-muted-foreground">
              {product.published_version ? `Template đang live v${product.published_version}` : "Chưa publish template"}
              {link && ` · Shopify: ${link.status.toLowerCase()} · deploy lần cuối ${new Date(link.deployedAt).toLocaleString()}`}
            </div>
          </div>
          <CtButton variant="primary" className="ml-auto" onClick={() => void deploy()} disabled={!canDeploy || running}>
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
            {link || target ? "Deploy cập nhật" : "Deploy lên Shopify"}
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
                    <div className="text-[11px] text-muted-foreground">
                      {target ? "Sẽ deploy lên sản phẩm này" : "Đã liên kết"} · {linked.status.toLowerCase()} · {linked.variantsCount} variant · /{linked.handle}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="font-medium">{link ? "Sản phẩm Shopify cũ không còn" : "Chưa có trên Shopify"}</div>
                    <div className="text-[11px] text-muted-foreground">Deploy sẽ tạo sản phẩm mới{info?.shop ? ` trên ${info.shop.domain}` : ""}.</div>
                  </>
                )}
              </div>
              {link && !target && (
                <div className="flex gap-1">
                  <a href={link.adminUrl} target="_blank" rel="noreferrer" className="rounded p-1.5 hover:bg-accent" title="Mở trong Shopify admin">
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </div>
              )}
              {target ? (
                <CtButton size="sm" variant="ghost" onClick={() => setTarget(null)}>
                  <X className="h-3.5 w-3.5" /> Bỏ chọn
                </CtButton>
              ) : (
                <CtButton size="sm" variant="outline" onClick={() => setSearching((v) => !v)}>
                  <Search className="h-3.5 w-3.5" /> {link ? "Đổi sản phẩm" : "Chọn sản phẩm có sẵn"}
                </CtButton>
              )}
            </div>
            {searching && (
              <ShopifyPicker
                currentCtId={product.id}
                onPick={(p) => {
                  setTarget(p);
                  setSearching(false);
                  fill(p, product.name);
                }}
                onClose={() => setSearching(false)}
              />
            )}

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
            {table ? <PriceSummary table={table} /> : <p className="text-xs text-muted-foreground">Deploy cần 1 bảng giá: Size × Pack, mỗi ô là 1 variant Shopify có giá.</p>}
            {problems.length > 0 && <Notice level="warn" text={problems.join(" ")} />}
          </Card>

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
                        <span className="ml-1 font-normal text-muted-foreground">· {v.layers} custom layer 1 ảnh (cố định)</span>
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
                <div className="space-y-1">
                  {audit.lines.map((l, i) => (
                    <Notice key={i} level={l.level} text={l.text} />
                  ))}
                </div>
                {table && usesPacks(table.config) && (
                  <Notice level="info" text={`Pack N cái: khách thiết kế N “${table.config.itemLabel}” độc lập (tab ${table.config.itemLabel} 1…N), cả N vào 1 dòng giỏ hàng.`} />
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
    <CtField label="Collections" hint="Bấm 1 badge để chọn collection hiện trên breadcrumb (★). Loại sản phẩm (product type) là trường khác, không phải collection.">
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <CtSelect
            value=""
            onChange={add}
            placeholder={collections.length ? "Thêm vào collection…" : "Store chưa có collection — tạo mới"}
            options={collections.filter((c) => !picked.includes(c.id)).map((c) => ({ value: c.id, label: c.smart ? `${c.title} (tự động)` : c.title, disabled: c.smart }))}
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
      <div className="text-muted-foreground">
        {[sizes.length ? `${cfg.sizeLabel}: ${sizes.map((s) => s.label).join(" · ")}` : null, packs.length ? `${cfg.packLabel}: ${packs.map((p) => p.label).join(" · ")}` : null]
          .filter(Boolean)
          .join(" — ") || "1 giá, không option"}
        {` → ${cells.length} variant`}
      </div>
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

function ShopifyPicker({ currentCtId, onPick, onClose }: { currentCtId: string; onPick: (p: CtShopifyProductSummary) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [list, setList] = useState<CtShopifyProductSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      ctApi
        .searchShopifyProducts(q)
        .then((r) => !cancelled && (setList(r), setError(null)))
        .catch((e: Error) => !cancelled && setError(e.message));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q]);
  return (
    <div className="space-y-2 rounded-md border p-2">
      <div className="flex items-center gap-2">
        <CtInput className="h-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm sản phẩm Shopify theo tên / handle…" autoFocus />
        <CtButton size="icon" variant="ghost" onClick={onClose} aria-label="Đóng">
          <X className="h-4 w-4" />
        </CtButton>
      </div>
      {error && <Notice level="error" text={error} />}
      {!list ? (
        <Loader2 className="mx-auto h-4 w-4 animate-spin" />
      ) : list.length === 0 ? (
        <p className="text-xs text-muted-foreground">Không thấy sản phẩm.</p>
      ) : (
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {list.map((p) => {
            const other = p.ctProductId && p.ctProductId !== currentCtId;
            return (
              <button key={p.id} className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-accent" onClick={() => onPick(p)}>
                {p.imageUrl ? <img src={p.imageUrl} alt="" className="h-8 w-8 rounded object-cover" /> : <div className="h-8 w-8 rounded bg-muted" />}
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{p.title}</div>
                  <div className="truncate text-muted-foreground">
                    {p.status.toLowerCase()} · {p.variantsCount} variant · {p.options.map((o) => o.name).join(" / ")}
                    {other && <span className="ml-1 text-amber-600">· đang gắn sản phẩm FlexiPrint khác</span>}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">Deploy sẽ thay options + variants + giá của sản phẩm đó theo bảng giá.</p>
    </div>
  );
}
