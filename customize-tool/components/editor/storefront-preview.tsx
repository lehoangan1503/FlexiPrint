"use client";

/**
 * "Xem trước": the product page exactly as a Shopify customer sees it — the
 * markup of shopify/sections/main-product.liquid, its CSS, and the SAME
 * storefront Customizer class (storefront/customizer.ts) that the theme runs.
 *
 * The template is built from the current, unsaved design with the same
 * buildTemplate() Publish uses, and swapped in live, so a zone or option
 * added in "Thiết kế" appears here at once. Nothing is uploaded; Add to cart
 * shows the line-item properties the real cart would receive.
 *
 * Keep the markup below in sync with main-product.liquid (DOM contract at the
 * top of storefront/customizer.ts).
 */

import "../../shopify/assets/ct-customizer.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { Eye, ShoppingCart, X } from "lucide-react";
import type { CtAsset, CtProduct, CtProductConfig, CtRegion, CtRegionItem, CtTemplate } from "../../types";
import { buildTemplate } from "../../lib/template";
import { isAiStyleRef } from "../../lib/photo-styles";
import { normalizeRegion } from "../../lib/design";
import { ctApi } from "../../lib/api-client";
import { Customizer, initGallery, type CtCartPreview } from "../../storefront/customizer";
import { useAiStyles } from "./ai-styles-store";
import { CtButton } from "../ui";

export interface StorefrontPreviewProps {
  product: CtProduct;
  assets: CtAsset[];
  regions: CtRegion[];
  items: CtRegionItem[];
  config: CtProductConfig;
}

/** Section settings the theme editor would provide (the liquid schema defaults). */
const SECTION_TEXT = {
  heading: "Personalized",
  upload: "Upload your photo",
  required: "Please complete",
  photos: "View product photos",
  design: "Preview my design",
  add: "Add to cart",
};

export function StorefrontPreview({ product, assets, regions, items, config }: StorefrontPreviewProps) {
  const { names } = useAiStyles();
  const [cart, setCart] = useState<CtCartPreview | null>(null);

  const draft = useMemo((): { template: CtTemplate | null; error: string | null } => {
    const refs = new Set(regions.map(normalizeRegion).flatMap((r) => (r.kind === "photo" ? r.config.photo.styles.filter(isAiStyleRef) : [])));
    try {
      const template = buildTemplate({
        product: { ...product, config },
        assets,
        regions,
        items,
        // What the next Publish would be.
        version: (product.published_version ?? 0) + 1,
        publishedAt: new Date().toISOString(),
        aiStyles: names.filter((n) => refs.has(n.ref)),
      });
      return { template, error: null };
    } catch (e) {
      return { template: null, error: e instanceof Error ? e.message : "Không dựng được template" };
    }
  }, [product, config, assets, regions, items, names]);

  // Product media on the left = the mockups (what a Shopify product would list). A new product
  // without mockups starts on the live design, like a Shopify product without media.
  const mockups = useMemo(() => assets.filter((a) => a.role === "mockup"), [assets]);
  const mountKey = `${product.id}|${mockups.map((m) => m.id).join(",")}`;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b bg-background px-3 py-2 text-xs text-muted-foreground">
        <Eye className="h-3.5 w-3.5" />
        <span>
          Trang sản phẩm như khách thấy trên Shopify (<code>main-product.liquid</code>) — chạy trên bản thiết kế hiện tại, kể cả chưa lưu. Sửa ở tab
          <b className="text-foreground"> Thiết kế</b>; lên store sau khi <b className="text-foreground">Publish</b>.
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" style={{ background: "#faf8f5", color: "#1c1b1a", colorScheme: "light" }}>
        {draft.template ? (
          <LiveStorefront key={mountKey} title={product.name} mockups={mockups} template={draft.template} photoUrl={ctApi.photoEndpoint(product.id)} onCart={setCart} />
        ) : (
          <p className="p-10 text-center text-sm" style={{ color: "#6b6b6b" }}>
            {draft.error}
          </p>
        )}
      </div>
      {cart && <CartSheet cart={cart} onClose={() => setCart(null)} />}
    </div>
  );
}

/**
 * The section markup + a mounted Customizer. React renders the static shell
 * once; the Customizer owns everything inside [data-ct-options], the stage
 * and the gallery toggles (React never re-applies those props because they
 * never change between renders). A new mockup list remounts it via `key`.
 */
function LiveStorefront({
  title,
  mockups,
  template,
  photoUrl,
  onCart,
}: {
  title: string;
  mockups: CtAsset[];
  template: CtTemplate;
  photoUrl: string;
  onCart: (cart: CtCartPreview) => void;
}) {
  const rootRef = useRef<HTMLElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const customizer = useRef<Customizer | null>(null);
  const latest = useRef({ template, onCart });
  // Declared before the mount effect, so the mount reads the current values.
  useEffect(() => {
    latest.current = { template, onCart };
  });

  useEffect(() => {
    const root = rootRef.current;
    const form = formRef.current;
    if (!root || !form) return;
    const c = new Customizer(root, form, {
      template: latest.current.template,
      uploadUrl: null,
      photoUrl,
      onPreviewCart: (cart) => latest.current.onCart(cart),
    });
    customizer.current = c;
    // Same boot order as storefront/index.ts. The thumbnail listeners die with this DOM (remounted via key).
    initGallery(root);
    void c.start();
    return () => {
      c.destroy();
      customizer.current = null;
    };
  }, [photoUrl]);

  // Live design changes: swap the template in place (debounced — dragging a zone fires per frame).
  useEffect(() => {
    const id = window.setTimeout(() => customizer.current?.setTemplate(template), 150);
    return () => window.clearTimeout(id);
  }, [template]);

  return (
    <section ref={rootRef} id="ct-editor-preview" className="ct-product mx-auto max-w-[1200px] px-6" data-ct-product style={{ fontFamily: "Poppins, system-ui, sans-serif" }}>
      <div className="ct-product__media">
        <div className="ct-gallery" data-ct-gallery hidden={mockups.length === 0}>
          <div className="ct-gallery__main" data-ct-gallery-main>
            {mockups.map((m, i) => (
              <div key={m.id} className="ct-gallery__slide" data-media-id={m.id} hidden={i !== 0}>
                <img src={m.url} alt={m.name} />
              </div>
            ))}
          </div>
          {mockups.length > 1 && (
            <div className="ct-gallery__thumbs">
              {mockups.map((m, i) => (
                <button key={m.id} type="button" className={`ct-gallery__thumb${i === 0 ? " is-active" : ""}`} data-ct-thumb={m.id} aria-label={m.name}>
                  <img src={m.url} alt="" loading="lazy" />
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="ct-stage" data-ct-stage hidden>
          <canvas aria-label="Live preview of your design" />
          {mockups.length > 0 && (
            <button type="button" className="ct-stage__toggle" data-ct-show-photos>
              {SECTION_TEXT.photos}
            </button>
          )}
        </div>
        {mockups.length > 0 && (
          <button type="button" className="ct-show-design" data-ct-show-design>
            {SECTION_TEXT.design}
          </button>
        )}
      </div>

      <div className="ct-product__info">
        <h1 className="ct-product__title">{title}</h1>
        <div className="ct-product__price">
          <span style={{ color: "#6b6b6b", fontSize: 15 }}>Giá lấy từ variant Shopify</span>
        </div>
        <form ref={formRef} className="ct-form" data-ct-form noValidate onSubmit={(e) => e.preventDefault()}>
          <div className="ct-options" data-ct-options />
          <div className="ct-buy">
            <label className="ct-qty">
              <input type="number" name="quantity" defaultValue={1} min={1} inputMode="numeric" aria-label="Quantity" />
            </label>
            <button type="submit" name="add" className="ct-btn ct-btn--primary ct-add">
              <span data-ct-submit-label>{SECTION_TEXT.add}</span>
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}

/** What the real cart line would carry — the same properties the theme posts to /cart/add. */
function CartSheet({ cart, onClose }: { cart: CtCartPreview; onClose: () => void }) {
  return (
    <div className="fixed inset-y-0 right-0 z-50 flex w-[420px] max-w-full flex-col border-l bg-background shadow-2xl">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <ShoppingCart className="h-4 w-4" />
        <span className="text-sm font-semibold">Giỏ hàng sẽ nhận (preview, chưa gửi Shopify)</span>
        <CtButton size="icon" variant="ghost" className="ml-auto" onClick={onClose}>
          <X className="h-4 w-4" />
        </CtButton>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {cart.previewUrl && <img src={cart.previewUrl} alt="" className="w-full rounded border" />}
        <table className="w-full text-xs">
          <tbody>
            {cart.properties.map(([k, v]) => (
              <tr key={k} className="border-b align-top">
                <td className="py-1.5 pr-2 font-medium">
                  {k}
                  {k.startsWith("_") && <span className="ml-1 text-[10px] text-muted-foreground">(ẩn)</span>}
                </td>
                <td className="max-w-[220px] break-all py-1.5 text-muted-foreground">{v.length > 160 ? `${v.slice(0, 160)}…` : v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-[11px] text-muted-foreground">
          Trên store, ảnh khách và ảnh preview được upload rồi mới thêm vào giỏ; ở đây chúng là ảnh tạm trong trình duyệt.
        </p>
      </div>
    </div>
  );
}
