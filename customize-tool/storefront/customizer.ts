/**
 * The storefront customizer for `shopify/sections/flexi2-product.liquid` — no
 * side effects on import. Two hosts mount it:
 *
 *   storefront/index.ts   the Shopify theme (bundled to shopify/assets/flexi2-customizer.js),
 *                         template fetched from the public endpoint (latest Publish)
 *   editor "Xem trước"    components/editor/storefront-preview.tsx, template built
 *                         from the unsaved draft and swapped live via setTemplate(),
 *                         nothing uploaded, Add to cart shows what would be posted
 *
 * It renders with lib/compositor.ts — the exact code the editor uses — so the
 * cart preview is what was designed. Every option comes from the template
 * JSON, so a zone / option created in the editor needs no theme change.
 *
 * DOM contract (all inside one [data-ct-product]):
 *   [data-ct-gallery]            product media (mockups); shown first
 *   [data-ct-stage] > canvas     live custom preview; replaces the gallery on
 *                                the customer's first option change
 *   [data-ct-options]            where the option form is rendered
 *   form[data-ct-form]           the /cart/add form
 *   script[data-ct-variants]     { variantId: { price, compare, available, media, cents } }
 *   script[data-ct-pricing]      metafield customize_tool.pricing (CtShopifyPricing; absent = 1 design)
 *   [data-ct-pack-unit="<value>"] per-piece price of a pack card, filled for the chosen size
 *   [data-ct-design-nav]         "Ornament 2/6" arrows on the stage (shown with 2+ designs)
 *   data-ct-template-url / data-ct-upload-url on the root (absent = plain product page)
 *   data-ct-money-format         shop money format ("${{amount}}")
 *
 * A pack variant ("6 PCS", Buy More Save More — Different Designs) holds that many independent designs: the form
 * gets tabs "<item> 1…6", each with its own choices, and the cart line carries all of them.
 *
 * Custom layers (image zones) are the designer's: they draw the picture picked in the editor (template.picks) and
 * never show a picker. The customer's options are the main version (+ its sub-options), text and photo zones (+
 * their sub-options).
 *
 * A gallery without product media starts on the live canvas.
 */

import { optionThumb } from "../lib/option-thumb";
import { CT_MAIN_KEY } from "../types";
import type {
  CtVersionPhoi,
  CtMockupEdit,
  CtOptionDisplay,
  CtPackFrameLayer,
  CtPhotoSelection,
  CtPhotoTask,
  CtPhotoTaskPhoi,
  CtPhotoStyleRef,
  CtPublicAiStyle,
  CtProductScene,
  CtRegion,
  CtRenderAsset,
  CtSelection,
  CtShopifyPricing,
  CtTemplate,
  CtTextSelection,
  CtTransform,
} from "../types";
import { ctGoogleFontsHref } from "../config";
import { canvasToBlob, compositeBleed, drawComposite, loadImage, mirrorSheet, printFrame, renderComposite, silhouetteCutOf, withSilhouette } from "../lib/compositor";
import { isHidden, layoutFor, onVersion } from "../lib/layout";
import { drawOnScene } from "../lib/scene";
import { renderZoneMockup, zoneFills } from "../lib/zone-mockup";
import { printSize } from "../lib/print-template";
import { renderSlide, type CtSlotArt } from "../lib/mockup";
import {
  customerOptionName,
  defaultRegionSelection,
  formatDateInput,
  isValidDate,
  defaultSelection,
  fontsUsed,
  isSelectionValid,
  formOrder,
  locateOption,
  mainSubOptions,
  mainVersions,
  normalizeProductConfig,
  normalizeRegion,
  optionInGroup,
  activeRegions,
  regionForSelection,
  textMode,
  zoneText,
  regionGroups,
  selectedMainId,
  selectedMainImageId,
  isLinkedLayer,
} from "../lib/design";
import { IDENTITY_TRANSFORM, itemPlacement, photoFrameBox, resolvePhotoFrame, shapeBounds } from "../lib/geometry";
import { faceTargets } from "../lib/face-center";
import { filterBlob, processPhoto, shrinkImage } from "../lib/photo-process";
import { isAiStyleRef, styleEngine, styleFamily, styleFilter, styleLabel } from "../lib/photo-styles";
import { phoiPicks, phoiTaskKey } from "../lib/photo-task-key";
import { addTask, getTask, latestForPage, onTasks, TASK_PARAM, taskWorking, updateTask, type CtStoredTask } from "./tasks";
import { createMagicLoader, type MagicLoader } from "./magic-loader";

interface VariantInfo {
  price: string;
  compare: string | null;
  available: boolean;
  media: string | null;
  /** Price in cents (per-piece prices of pack cards). */
  cents?: number;
}

interface VariantRow {
  id: number;
  options: string[];
}

/** Detail of the "ct:variant" event the variant picker fires on the section root. */
export interface CtVariantChange {
  options: string[];
  names: string[];
}

/** Shopify money format ("${{amount}}", "{{amount_with_comma_separator}} €"). */
export function formatMoney(cents: number, format: string): string {
  const fmt = (n: number, decimals: number, thousands: string, dec: string) => {
    const [whole, frac] = (n / 100).toFixed(decimals).split(".");
    return whole.replace(/\B(?=(\d{3})+(?!\d))/g, thousands) + (frac ? dec + frac : "");
  };
  return format.replace(/\{\{\s*(\w+)\s*\}\}/, (_m, key: string) => {
    switch (key) {
      case "amount_no_decimals":
        return fmt(cents, 0, ",", ".");
      case "amount_with_comma_separator":
        return fmt(cents, 2, ".", ",");
      case "amount_no_decimals_with_comma_separator":
        return fmt(cents, 0, ".", ",");
      case "amount_with_apostrophe_separator":
        return fmt(cents, 2, "'", ".");
      default:
        return fmt(cents, 2, ",", ".");
    }
  });
}

/** The option values currently picked in the variant picker, by option index. */
function pickedOptions(root: HTMLElement): string[] {
  const out: string[] = [];
  for (const s of Array.from(root.querySelectorAll<HTMLSelectElement | HTMLInputElement>("[data-ct-option-index]"))) {
    if (s instanceof HTMLInputElement && s.type === "radio" && !s.checked) continue;
    out[Number(s.dataset.ctOptionIndex)] = s.value;
  }
  return out;
}

function optionNames(root: HTMLElement): string[] {
  const out: string[] = [];
  for (const f of Array.from(root.querySelectorAll<HTMLElement>("[data-ct-option-name]"))) out[Number(f.dataset.ctOptionPosition)] = f.dataset.ctOptionName ?? "";
  return out;
}

/** How many designs the picked variant holds (its pack), 1 without a price table. */
export function designCount(pricing: CtShopifyPricing | null, names: string[], options: string[]): number {
  if (!pricing?.packOption) return 1;
  const i = names.findIndex((n) => n.toLowerCase() === pricing.packOption?.toLowerCase());
  const value = i >= 0 ? options[i] : undefined;
  const n = value !== undefined ? pricing.packs[value] : undefined;
  return typeof n === "number" && n >= 1 ? Math.min(50, Math.round(n)) : 1;
}

interface PickerOption {
  id: string;
  label: string;
  image?: string;
  swatch?: string;
}

/** What Add to cart would post, handed to the editor preview instead of submitting. */
export interface CtCartPreview {
  /** Line-item properties in form order: [name, value]; names starting with "_" are hidden in the cart. */
  properties: Array<[string, string]>;
  /** Flattened render of the (first) design (object URL in preview mode). */
  previewUrl: string;
  /** One render per design of a pack. */
  previews: string[];
}

export interface CtCustomizerOptions {
  /** URL of the published template (storefront) or the template itself (editor preview). */
  template: string | CtTemplate;
  /** Public upload endpoint; null = preview mode: nothing is uploaded or added to a cart. */
  uploadUrl: string | null;
  /** Photo processing endpoint (style + cut-out). */
  photoUrl: string;
  /** Preview mode: receives the would-be cart line instead of submitting the form. */
  onPreviewCart?: (cart: CtCartPreview) => void;
}

/** A product of Shopify's /recommendations/products.json. */
interface CtRecoProduct {
  title: string;
  url: string;
  featured_image: string;
  available?: boolean;
  /** Cents. */
  price?: number;
}

/** A product of /collections/<handle>/products.json. */
interface CtCollectionProduct {
  title: string;
  handle: string;
  images?: Array<{ src: string }>;
  variants?: Array<{ price: string; available?: boolean }>;
}

interface CtShopifyWindow extends Window {
  Shopify?: { routes?: { root?: string } };
}

const PREVIEW_MAX_PX = 1200;
const PHOTO_MAX_PX = 3000;

// ---------------------------------------------------------------------------
// small DOM helpers
// ---------------------------------------------------------------------------

type Attrs = Record<string, string | boolean | undefined>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, children: Array<Node | string> = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "class") node.className = String(v);
    else if (k === "text") node.textContent = String(v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) node.append(c);
  return node;
}

export function readJson<T>(root: ParentNode, selector: string): T | null {
  const s = root.querySelector<HTMLScriptElement>(selector);
  if (!s?.textContent) return null;
  try {
    return JSON.parse(s.textContent) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Gallery + variant picker (works for every product, custom or not)
// ---------------------------------------------------------------------------

export function initGallery(root: HTMLElement): { showMedia: (mediaId: string | null) => void } {
  const main = root.querySelector<HTMLElement>("[data-ct-gallery-main]");
  const thumbs = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-ct-thumb]"));
  const show = (id: string | null) => {
    if (!main || !id) return;
    for (const slide of Array.from(main.querySelectorAll<HTMLElement>("[data-media-id]"))) slide.hidden = slide.dataset.mediaId !== id;
    for (const t of thumbs) t.classList.toggle("is-active", t.dataset.ctThumb === id);
  };
  for (const t of thumbs) t.addEventListener("click", () => {
    show(t.dataset.ctThumb ?? null);
    root.dispatchEvent(new CustomEvent("ct:show-gallery"));
  });
  return { showMedia: show };
}

export function initVariants(root: HTMLElement, form: HTMLFormElement, showMedia: (id: string | null) => void): void {
  const variants = readJson<Record<string, VariantInfo>>(root, "script[data-ct-variants]") ?? {};
  const matrix = readJson<VariantRow[]>(root, "script[data-ct-variant-options]") ?? [];
  const pricing = readJson<CtShopifyPricing>(root, "script[data-ct-pricing]");
  const moneyFormat = root.dataset.ctMoneyFormat || "${{amount}}";
  const idInput = form.querySelector<HTMLInputElement>('input[name="id"]');
  const selects = Array.from(root.querySelectorAll<HTMLSelectElement | HTMLInputElement>("[data-ct-option-index]"));
  // The info column + the sticky bar both show the price.
  const prices = Array.from(root.querySelectorAll<HTMLElement>("[data-ct-price]"));
  const compares = Array.from(root.querySelectorAll<HTMLElement>("[data-ct-compare]"));
  // Other forms of the variant (Shop Pay installments) follow the picked variant too.
  const otherIds = Array.from(root.querySelectorAll<HTMLInputElement>("input[data-ct-variant-id]")).filter((i) => i !== idInput);
  const submit = form.querySelector<HTMLButtonElement>('[type="submit"]');
  const names = optionNames(root);
  const packIndex = pricing?.packOption ? names.findIndex((n) => n.toLowerCase() === pricing.packOption?.toLowerCase()) : -1;

  /** Pack cards: the price of one piece for the size (other options) now picked. */
  const unitPrices = (chosen: string[]) => {
    if (packIndex < 0 || !pricing) return;
    for (const node of Array.from(root.querySelectorAll<HTMLElement>("[data-ct-pack-unit]"))) {
      const value = node.dataset.ctPackUnit ?? "";
      const qty = pricing.packs[value] ?? 1;
      const want = chosen.map((v, i) => (i === packIndex ? value : v));
      const row = matrix.find((v) => v.options.every((o, i) => want[i] === undefined || want[i] === o));
      const cents = row ? variants[String(row.id)]?.cents : undefined;
      node.textContent = typeof cents === "number" ? `${formatMoney(Math.round(cents / Math.max(1, qty)), moneyFormat)}/pc` : "";
    }
  };

  const sync = (initial = false) => {
    const chosen = pickedOptions(root);
    unitPrices(chosen);
    for (const s of selects) {
      if (s instanceof HTMLInputElement && s.type === "radio") s.closest(".ct-pill, .ct-pack")?.classList.toggle("is-selected", s.checked);
    }
    // "Size: 4"x4"" — the picked value next to each option name.
    for (const node of Array.from(root.querySelectorAll<HTMLElement>("[data-ct-option-value]"))) {
      node.textContent = chosen[Number(node.dataset.ctOptionValue)] ?? "";
    }
    root.dispatchEvent(new CustomEvent<CtVariantChange>("ct:variant", { detail: { options: chosen, names } }));
    if (initial) return;
    const match = matrix.find((v) => v.options.every((o, i) => chosen[i] === undefined || chosen[i] === o));
    if (!match) return;
    if (idInput) idInput.value = String(match.id);
    for (const other of otherIds) {
      other.value = String(match.id);
      other.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const info = variants[String(match.id)];
    if (!info) return;
    for (const price of prices) price.textContent = info.price;
    for (const compare of compares) {
      compare.textContent = info.compare ?? "";
      compare.hidden = !info.compare;
    }
    if (submit) {
      submit.disabled = !info.available;
      const label = submit.querySelector("[data-ct-submit-label]");
      if (label) label.textContent = info.available ? (submit.dataset.labelAdd ?? "Add to cart") : (submit.dataset.labelSoldout ?? "Sold out");
    }
    if (info.media) showMedia(info.media);
    // The editor's preview has no cart form id: it keeps its own URL.
    if (!idInput) return;
    const url = new URL(window.location.href);
    url.searchParams.set("variant", String(match.id));
    window.history.replaceState(null, "", url.toString());
  };
  for (const s of selects) s.addEventListener("change", () => sync());
  sync(true);
}

// ---------------------------------------------------------------------------
// Customizer
// ---------------------------------------------------------------------------

export class Customizer {
  private tpl!: CtTemplate;
  private main!: CtRenderAsset;
  /**
   * One selection per design of the picked pack ("6 PCS" = 6 designs); `active` is the one the form and the stage
   * show. Designs past `count` are kept (switching back to a bigger pack restores them) but not ordered.
   */
  private designs: CtSelection[] = [{}];
  private count = 1;
  private active = 0;
  private pricing: CtShopifyPricing | null = null;
  private regions: CtRegion[] = [];
  private raf = 0;
  private renderToken = 0;
  /** Local object URL -> its bytes, for photos (originals and renders) not uploaded yet. */
  private localBlobs = new Map<string, Blob>();
  /** The name typed in a photo dialog, by zone (a style with askName puts it in its prompt) — kept when it reopens. */
  private photoNames = new Map<string, string>();
  /** The name a styled photo was drawn with (its url → name): a different name typed later redraws it. */
  private nameOfPhoto = new Map<string, string>();
  /** Local object URL -> public URL, one upload per blob however often it is asked for. */
  private uploads = new Map<string, Promise<string>>();
  /** A finished photo (public url) -> the photo task that made it (server/photo-tasks.ts, storefront/tasks.ts). */
  private readonly taskByPhoto = new Map<string, string>();
  private phoiTimer = 0;
  private recos: Promise<CtRecoProduct[]> | null = null;
  /** "Making your realistic preview…" over the stage while the shown design's phôi is drawn. */
  private badge: HTMLElement | null = null;
  /** A task whose photo is not in the design yet (restored / left early): the stage says it is coming. */
  private waitingTask: string | null = null;

  private readonly stage: HTMLElement | null;
  private readonly gallery: HTMLElement | null;
  private readonly canvas: HTMLCanvasElement | null;
  private readonly optionsHost: HTMLElement;
  private readonly errorBox: HTMLElement;
  private readonly uploadUrl: string | null;
  private readonly photoUrl: string;
  /** Undo everything start() attached (listeners, observer) — see destroy(). */
  private readonly cleanups: Array<() => void> = [];
  private destroyed = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly form: HTMLFormElement,
    private readonly options: CtCustomizerOptions,
  ) {
    this.uploadUrl = options.uploadUrl;
    this.photoUrl = options.photoUrl;
    this.stage = root.querySelector("[data-ct-stage]");
    this.gallery = root.querySelector("[data-ct-gallery]");
    this.canvas = root.querySelector("[data-ct-stage] canvas");
    this.optionsHost = root.querySelector("[data-ct-options]") ?? form;
    this.errorBox = el("div", { class: "ct-error", role: "alert", hidden: true });
  }

  private get previewMode(): boolean {
    return this.uploadUrl === null;
  }

  /** The design being edited. */
  private get selection(): CtSelection {
    return this.designs[this.active] ?? {};
  }

  private set selection(sel: CtSelection) {
    this.designs[this.active] = sel;
  }

  /** A fresh design: defaults, with each custom layer showing the designer's picture. */
  private freshSelection(): CtSelection {
    const tpl = this.tpl;
    return this.withPicks(defaultSelection(this.regions, tpl.items, tpl.assets, tpl.mainAssetId));
  }

  private withPicks(sel: CtSelection): CtSelection {
    const picks = this.tpl.picks;
    if (!picks) return sel;
    const out = { ...sel };
    for (const r of this.regions) if (r.kind === "image" && r.id in picks) out[r.id] = { kind: "image", assetId: picks[r.id] };
    return out;
  }

  /** A custom layer with fewer than 2 pictures to pick from is simply drawn (no picker, not in the cart). */
  private isFixedLayer(r: CtRegion): boolean {
    if (r.kind !== "image") return false;
    // A linked layer shows what its leader shows: no picker, not in the cart.
    if (isLinkedLayer(r, this.regions)) return true;
    const offered = regionGroups(r, this.tpl.items, this.tpl.assets).reduce((n, g) => n + g.options.length, 0);
    return offered + (r.config.image.allowNone ? 1 : 0) < 2;
  }

  private itemLabel(i: number): string {
    return `${this.pricing?.itemLabel || this.t("item", "Design")} ${i + 1}`;
  }

  /** The pack changed: as many designs as it holds. */
  private setCount(n: number): void {
    const count = Math.max(1, n);
    if (count === this.count) return;
    while (this.designs.length < count) this.designs.push(this.freshSelection());
    this.count = count;
    this.active = Math.min(this.active, count - 1);
    this.errorBox.hidden = true;
    this.renderOptions();
    this.renderNav();
    this.scheduleRender();
  }

  private goTo(i: number): void {
    const next = (i + this.count) % this.count;
    if (next === this.active) return;
    this.active = next;
    this.errorBox.hidden = true;
    this.renderOptions();
    this.renderNav();
    this.showStage();
  }

  /** "Ornament 2/6" with arrows on the stage; hidden for a single design. */
  private renderNav(): void {
    const nav = this.root.querySelector<HTMLElement>("[data-ct-design-nav]");
    if (!nav) return;
    nav.hidden = this.count < 2;
    const label = nav.querySelector("[data-ct-design-label]");
    if (label) label.textContent = `${this.pricing?.itemLabel || this.t("item", "Design")} ${this.active + 1}/${this.count}`;
  }

  async start(): Promise<void> {
    let tpl: CtTemplate;
    if (typeof this.options.template === "string") {
      this.optionsHost.append(el("div", { class: "ct-loading", text: this.t("loading", "Loading personalization…") }));
      try {
        const res = await fetch(this.options.template, { mode: "cors" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        tpl = (await res.json()) as CtTemplate;
      } catch (e) {
        // No template = plain product page; keep the form usable.
        this.optionsHost.replaceChildren();
        console.warn("[ct] template not loaded", e);
        return;
      }
    } else {
      tpl = this.options.template;
    }
    if (this.destroyed || !this.applyTemplate(tpl)) return;
    this.designs = [this.freshSelection()];
    this.root.classList.add("ct-is-custom");
    // The pack variant picked decides how many designs the line holds.
    this.pricing = readJson<CtShopifyPricing>(this.root, "script[data-ct-pricing]");
    const packOf = (names: string[], options: string[]) => designCount(this.pricing, names, options);
    this.count = 1;
    const initial = packOf(optionNames(this.root), pickedOptions(this.root));
    this.listen(this.root, "ct:variant", (e) => {
      const d = (e as CustomEvent<CtVariantChange>).detail;
      this.setCount(packOf(d.names, d.options));
    });
    const prev = this.root.querySelector("[data-ct-design-prev]");
    const nextBtn = this.root.querySelector("[data-ct-design-next]");
    if (prev) this.listen(prev, "click", () => this.goTo(this.active - 1));
    if (nextBtn) this.listen(nextBtn, "click", () => this.goTo(this.active + 1));

    if (initial > 1) this.setCount(initial);
    else this.renderOptions();
    this.renderNav();
    this.listen(this.form, "submit", (e) => void this.onSubmit(e as SubmitEvent), true);
    const photos = this.root.querySelector("[data-ct-show-photos]");
    if (photos) this.listen(photos, "click", () => this.showGallery());
    const design = this.root.querySelector("[data-ct-show-design]");
    if (design) this.listen(design, "click", () => this.showStage());
    this.listen(this.root, "ct:show-gallery", () => this.showGallery());
    if (this.canvas) {
      const ro = new ResizeObserver(() => this.scheduleRender());
      ro.observe(this.canvas.parentElement ?? this.canvas);
      this.cleanups.push(() => ro.disconnect());
    }
    // No product media to show (a new product, the editor preview): start on the design.
    if (!this.gallery?.querySelector("[data-media-id]")) this.showStage();
    if (!this.previewMode) {
      this.cleanups.push(onTasks(() => this.onTasksChanged()));
      this.restoreTask();
    }
  }

  /**
   * Swap in a new template (the editor preview, on every design change) and
   * keep whatever the customer already chose that is still valid, so a new
   * zone or option shows up at once without resetting the form.
   */
  setTemplate(tpl: CtTemplate): void {
    if (this.destroyed || !this.tpl) return;
    if (!this.applyTemplate(tpl)) return;
    this.designs = this.designs.map((sel) => this.carryOver(sel));
    this.renderOptions();
    this.scheduleRender();
  }

  /** What of `sel` is still valid on the (new) template; the rest falls back to its default. */
  private carryOver(sel: CtSelection): CtSelection {
    const tpl = this.tpl;
    const next = this.freshSelection();
    const main = sel[CT_MAIN_KEY];
    if (main?.kind === "main" && main.assetId && tpl.assets.some((a) => a.id === main.assetId && a.role === "main")) next[CT_MAIN_KEY] = main;
    for (const r of this.regions) {
      if (this.isFixedLayer(r)) continue;
      const cur = sel[r.id];
      if (!isSelectionValid(r, cur, tpl.items, tpl.assets)) continue;
      // Preset texts changed: a text no longer offered falls back to the first preset.
      const choices = r.config.text.choices.filter(Boolean);
      if (r.kind === "text" && cur?.kind === "text" && choices.length > 0 && !choices.includes(cur.text)) continue;
      next[r.id] = cur ?? defaultRegionSelection(r, tpl.items, tpl.assets);
    }
    return next;
  }

  /** Detach from the page (the editor preview unmounting). */
  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    for (const undo of this.cleanups.splice(0)) undo();
    for (const d of Array.from(document.querySelectorAll<HTMLDialogElement>("dialog.ct-dialog"))) {
      if (this.root.contains(d) || d.dataset.ctOwner === this.root.id) d.remove();
    }
    for (const url of this.localBlobs.keys()) URL.revokeObjectURL(url);
    this.localBlobs.clear();
  }

  private listen(target: EventTarget, type: string, fn: (e: Event) => void, capture = false): void {
    target.addEventListener(type, fn, capture);
    this.cleanups.push(() => target.removeEventListener(type, fn, capture));
  }

  private applyTemplate(tpl: CtTemplate): boolean {
    const main = tpl.assets.find((a) => a.id === tpl.mainAssetId);
    if (!main) return false;
    // Templates published before layouts / materials existed lack those keys.
    this.tpl = { ...tpl, config: normalizeProductConfig(tpl.config) };
    this.main = { ...main, width: tpl.width, height: tpl.height };
    this.regions = tpl.regions.map(normalizeRegion);
    const families = fontsUsed(this.regions);
    const href = ctGoogleFontsHref(families);
    const link = document.getElementById("ct-fonts");
    if (families.length && link?.getAttribute("href") !== href) {
      link?.remove();
      document.head.append(el("link", { id: "ct-fonts", rel: "stylesheet", href }));
    }
    // Warm the image cache so the first swap to the canvas is instant.
    void loadImage(main.url).catch(() => undefined);
    return true;
  }

  private t(key: string, fallback: string): string {
    return this.root.dataset[`ctT${key[0].toUpperCase()}${key.slice(1)}`] ?? fallback;
  }

  // ------------------------------------------------------------- stage
  private showStage(): void {
    if (!this.stage || !this.canvas) return;
    this.stage.hidden = false;
    if (this.gallery) this.gallery.hidden = true;
    this.root.classList.add("ct-stage-active", "ct-has-design");
    this.scheduleRender();
  }

  private showGallery(): void {
    if (!this.stage) return;
    this.stage.hidden = true;
    if (this.gallery) this.gallery.hidden = false;
    this.root.classList.remove("ct-stage-active");
  }

  private scheduleRender(): void {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => void this.renderStage());
  }

  private async renderStage(): Promise<void> {
    const canvas = this.canvas;
    if (!canvas || this.stage?.hidden) return;
    const token = ++this.renderToken;
    const box = canvas.parentElement?.clientWidth || canvas.clientWidth || 600;
    const side = box * (window.devicePixelRatio || 1);
    const me = this.tpl.config.mockupEdit;
    if (me) {
      const off = await this.mockupStage(me, side).catch(() => null);
      if (!off || token !== this.renderToken) return;
      canvas.width = off.width;
      canvas.height = off.height;
      canvas.getContext("2d")?.drawImage(off, 0, 0);
      return;
    }
    // Clothes: the product photo with its zones repainted in the picked patterns (lib/zone-mockup).
    const zm = this.tpl.config.zoneMockups?.[0];
    if (zm) {
      const off = await renderZoneMockup(zm, zoneFills(this.regions, this.tpl.assets, this.selection), side).catch(() => null);
      if (!off || token !== this.renderToken) return;
      canvas.width = off.width;
      canvas.height = off.height;
      canvas.getContext("2d")?.drawImage(off, 0, 0);
      return;
    }
    // The customer's own phôi (2026-11-09, server/photo-tasks.ts): the piece photographed WITH their photo and picks —
    // only the texts they type are laid on it. 2026-11-10 ("muốn chỉ upload ảnh, bước acrylic sẽ là cuối cùng show
    // luôn"): while it is drawn the flat photo is never shown — the last phôi of that version stays under an "updating"
    // badge, else the piece without that photo.
    const want = this.wantedPhoi(this.selection);
    const task = want?.stored.task ?? null;
    const working = !!task && taskWorking(task);
    const done = want && task?.phoi?.key === want.key ? task.phoi : null;
    const stale = !done && want && working && task?.phoi?.mainId === want.mainId ? task.phoi : null;
    const waitedOn = this.waitingTask ? getTask(this.waitingTask)?.task : null;
    const waiting = !!waitedOn && taskWorking(waitedOn);
    this.showBadge(
      waiting || (!!want && working && !done),
      stale ? this.t("updating", "Updating your realistic preview…") : this.t("realistic", "Making your realistic preview…"),
    );
    const mine = done ?? stale;
    if (mine) {
      const off = await this.phoiCanvas(mine, this.selection, side).catch(() => null);
      if (off && token === this.renderToken) {
        canvas.width = off.width;
        canvas.height = off.height;
        canvas.getContext("2d")?.drawImage(off, 0, 0);
        return;
      }
      if (token !== this.renderToken) return;
    }
    const shown: CtSelection = want && working ? { ...this.selection, [want.regionId]: { ...want.photo, url: null } } : this.selection;
    // The version's AI phôi (2026-11-08): its fixed parts are already in the photo as the real piece — only what the
    // customer picks or types is laid on it.
    const phoi = this.versionPhoi(shown);
    if (phoi) {
      const k = Math.min(1, side / Math.max(phoi.width, phoi.height));
      const scale = Math.min(1, (phoi.box.w * k) / this.main.width);
      const input = { main: this.main, assets: this.tpl.assets, regions: this.regions, items: this.tpl.items, selection: shown, layouts: this.tpl.config.layouts };
      const off = await renderComposite({ ...input, scale: Math.max(scale, 0.05), display: true, part: "dynamic" })
        .then((c) => drawOnScene({ url: phoi.url, width: phoi.width, height: phoi.height, box: phoi.box }, c, side, { x: 0, y: 0 }, true))
        .catch(() => null);
      if (!off || token !== this.renderToken) return;
      canvas.width = off.width;
      canvas.height = off.height;
      canvas.getContext("2d")?.drawImage(off, 0, 0);
      return;
    }
    // The design on the product's photo: the picked background's own photo (it already shows the print-only layers,
    // they are left out), else the phôi trơn (a blank piece: everything printed is drawn on it).
    const own = this.optionScene(shown);
    const scene = own ?? this.tpl.config.scene;
    // On the phôi photo a piece with a khuôn shows only the piece (cut to it, the hanging hole open), like it is made.
    const cut = !!scene.url && !!printFrame({ main: this.main, assets: this.tpl.assets, regions: this.regions, selection: shown });
    const b = cut ? { x: 0, y: 0 } : compositeBleed({ main: this.main, assets: this.tpl.assets, regions: this.regions, selection: shown, layouts: this.tpl.config.layouts });
    const bleed = { x: b.x / this.main.width, y: b.y / this.main.height };
    const off = await this.product(shown, side, !!own, cut)
      .then((c) => drawOnScene(scene, c, side, bleed))
      .catch(() => null);
    if (!off || token !== this.renderToken) return;
    canvas.width = off.width;
    canvas.height = off.height;
    canvas.getContext("2d")?.drawImage(off, 0, 0);
  }

  /** Live renders of designs for the mockup edit's frames, by selection — reused while a design does not change. */
  private liveArts = new Map<string, Promise<string>>();

  /**
   * Mockup edit: the tổ hợp's scene with the LIVE design in its product frames, drawn by the same code as the
   * editor's tổ hợp (lib/mockup.ts). A pack with a frame per design shows design k in frame k; with fewer frames
   * than designs the frames start at the design being edited (one frame = always the open design).
   */
  private async mockupStage(me: CtMockupEdit, side: number): Promise<HTMLCanvasElement> {
    const frames = me.slide.layers.filter((l): l is CtPackFrameLayer => l.type === "frame" && !l.hidden);
    const arts: Record<string, CtSlotArt> = {};
    const wanted = new Set<string>();
    await Promise.all(
      frames.map(async (f, k) => {
        const first = frames.length >= this.count ? 0 : this.active;
        const sel = this.count > 1 ? (this.designs[(first + k) % this.count] ?? this.selection) : this.selection;
        const key = JSON.stringify(sel);
        wanted.add(key);
        let job = this.liveArts.get(key);
        if (!job) {
          job = this.product(sel, 1400)
            .then((c) => canvasToBlob(c, "image/png"))
            .then((b) => URL.createObjectURL(b));
          job.catch(() => this.liveArts.delete(key));
          this.liveArts.set(key, job);
        }
        const rules = me.frames[f.id] ?? { hole: false, cord: "none" as const };
        arts[f.id] = { url: await job, hole: rules.hole, cord: rules.cord };
      }),
    );
    // Renders of designs no longer shown are freed (typing makes a new one per keystroke).
    for (const [key, job] of this.liveArts) {
      if (wanted.has(key)) continue;
      this.liveArts.delete(key);
      void job.then((url) => setTimeout(() => URL.revokeObjectURL(url), 5000)).catch(() => undefined);
    }
    return renderSlide({ slide: me.slide, arts, scale: side / Math.max(me.slide.width, me.slide.height), placeholders: false });
  }

  /**
   * The product as the customer sees it (material renditions are already swapped in by the template), long side
   * `maxSide` — grown by the material version's padding, so its plate / cord are not cut off.
   */
  private product(selection: CtSelection, maxSide: number, display = false, cutToFrame = false): Promise<HTMLCanvasElement> {
    const input = { main: this.main, assets: this.tpl.assets, regions: this.regions, items: this.tpl.items, selection, layouts: this.tpl.config.layouts };
    const b = cutToFrame ? { x: 0, y: 0 } : compositeBleed(input);
    const scale = Math.min(1, maxSide / Math.max(this.main.width + 2 * b.x, this.main.height + 2 * b.y));
    return renderComposite({ ...input, scale, bleed: !cutToFrame, display, cutToFrame });
  }

  /** The AI phôi of the shown version on the product's base (config.versionPhoi); null = none. */
  private versionPhoi(selection: CtSelection): CtVersionPhoi | null {
    const list = this.tpl.config.versionPhoi ?? [];
    if (!list.length) return null;
    const mainId = selectedMainId(selection, this.tpl.assets, this.tpl.mainAssetId);
    const base = this.tpl.config.viewBaseId;
    return list.find((v) => v.mainId === mainId && (!base || v.baseId === base)) ?? null;
  }

  /** The picked background's own product photo (config.mockupsByOption); null = none (the product's phôi is used). */
  private optionScene(selection: CtSelection): CtProductScene | null {
    for (const [layerId, byOption] of Object.entries(this.tpl.config.mockupsByOption ?? {})) {
      const sel = selection[layerId];
      if (sel?.kind === "image" && sel.assetId && byOption[sel.assetId]) return byOption[sel.assetId];
    }
    return null;
  }

  /**
   * The print file of a design on a khuôn in (config.print), full size: the sheet of the size picked in the variant
   * picker (an option value equal to a size name), cut to the khuôn's line. A product with no khuôn in still gets
   * one: the whole edit frame at full size, cut to the frame.
   */
  private async printFile(selection: CtSelection): Promise<HTMLCanvasElement> {
    const input = { main: this.main, assets: this.tpl.assets, regions: this.regions, items: this.tpl.items, selection, layouts: this.tpl.config.layouts };
    const print = this.tpl.config.print;
    const sil = this.tpl.config.printSilhouette;
    // The silhouette follows the khuôn the file is cut to (its outline + holes), else the print's own shape.
    const cut = () => silhouetteCutOf(printFrame(input), false);
    if (!print) return withSilhouette(await renderComposite({ ...input, scale: 1, cutToFrame: true }), sil, cut());
    const picked = pickedOptions(this.root);
    const size = print.spec.sizes.length ? printSize(print.spec, picked.find((v) => print.spec.sizes.some((s) => s.name.toLowerCase() === v.toLowerCase())) ?? null) : null;
    const sheet = await renderComposite({ ...input, scale: 1, cutToFrame: !size, size: size && size.id ? size : null });
    // A khuôn made as one half (one trouser leg): the other half is its mirror image.
    return withSilhouette(print.spec.mirror ? mirrorSheet(sheet) : sheet, sil, size?.id ? null : silhouetteCutOf(printFrame(input), print.spec.mirror));
  }

  /** Zones the chosen main version uses: its own layers (older templates: a layout may hide some). */
  private shownRegions(selection: CtSelection = this.selection): CtRegion[] {
    const mainId = selectedMainId(selection, this.tpl.assets, this.tpl.mainAssetId);
    const layout = layoutFor(this.tpl.config.layouts, mainId);
    // Child zones only while their parent shows the option they belong to.
    return activeRegions(formOrder(this.regions).filter((r) => onVersion(r, mainId) && !isHidden(layout, r.id)), selection);
  }

  private change(key: string, value: CtSelection[string]): void {
    this.selection = { ...this.selection, [key]: value };
    this.errorBox.hidden = true;
    this.renderOptions();
    this.showStage();
    this.syncTasks();
  }

  // ------------------------------------------------------------- options
  private renderOptions(): void {
    const tpl = this.tpl;
    const wrap = el("div", { class: "ct-personalize" });
    wrap.append(el("div", { class: "ct-personalize__head", text: this.t("heading", "Personalized") }));
    // A pack of different designs: one tab per design, the form below is the active one's.
    if (this.count > 1) {
      const tabs = el("div", { class: "ct-designs", role: "tablist" });
      for (let i = 0; i < this.count; i++) {
        const tab = el("button", { type: "button", role: "tab", class: `ct-designs__tab${i === this.active ? " is-active" : ""}`, "aria-selected": String(i === this.active) }, [
          el("span", { class: "ct-designs__icon", "aria-hidden": "true", text: "✎" }),
          this.itemLabel(i),
        ]);
        tab.addEventListener("click", () => this.goTo(i));
        tabs.append(tab);
      }
      wrap.append(tabs, el("div", { class: "ct-designs__title" }, [el("span", { text: this.itemLabel(this.active) })]));
      // Keep the active tab in view on narrow screens — the tab strip scrolls sideways, never the page (2026-10-30:
      // scrollIntoView pulled the page back up to the tabs on every option click).
      requestAnimationFrame(() => {
        const active = tabs.querySelector<HTMLElement>(".is-active");
        if (!active) return;
        const strip = tabs.getBoundingClientRect();
        const tab = active.getBoundingClientRect();
        if (tab.left < strip.left) tabs.scrollLeft -= strip.left - tab.left;
        else if (tab.right > strip.right) tabs.scrollLeft += tab.right - strip.right;
      });
    }

    const mains = tpl.config.main.enabled ? mainVersions(tpl.assets, tpl.mainAssetId) : [];
    const current = selectedMainId(this.selection, tpl.assets, tpl.mainAssetId);
    if (mains.length > 1) {
      wrap.append(
        this.field(
          tpl.config.main.label,
          this.picker(
            tpl.config.main.display,
            mains.map((m) => ({ id: m.id, label: m.name, image: m.meta.thumb ?? m.url, swatch: m.meta.swatch })),
            current,
            false,
            (id) => id && this.change(CT_MAIN_KEY, { kind: "main", assetId: id, optionId: null }),
          ),
          true,
          mains.find((m) => m.id === current)?.name,
        ),
      );
    }
    // The chosen version's sub-options ("Thêm option"): the version itself first, then its other pictures. With one
    // version they are the only choice, under the main label ("Choose color").
    const version = mains.find((m) => m.id === current);
    const subs = version ? mainSubOptions(tpl.assets, tpl.config.main, version.id) : [];
    if (version && subs.length) {
      const shown = selectedMainImageId(this.selection, tpl.assets, tpl.mainAssetId);
      const list = [version, ...subs];
      wrap.append(
        this.field(
          mains.length > 1 ? version.name : tpl.config.main.label,
          this.picker(
            tpl.config.main.display,
            list.map((m) => ({ id: m.id, label: m.name, image: m.meta.thumb ?? m.url, swatch: m.meta.swatch })),
            shown,
            false,
            (id) => id && this.change(CT_MAIN_KEY, { kind: "main", assetId: version.id, optionId: id === version.id ? null : id }),
          ),
          true,
          list.find((m) => m.id === shown)?.name,
        ),
      );
    }

    // Zones as a tree: a child zone's fields come right under the option that opened it.
    const shown = this.shownRegions();
    const ids = new Set(shown.map((r) => r.id));
    const emit = (r: CtRegion, depth: number) => {
      for (const node of this.regionFields(r)) {
        if (depth > 0) {
          node.classList.add("ct-field--child");
          node.style.setProperty("--ct-depth", String(depth));
        }
        wrap.append(node);
      }
      for (const c of shown) if (c.config.parent?.regionId === r.id) emit(c, depth + 1);
    };
    for (const r of shown) if (!r.config.parent || !ids.has(r.config.parent.regionId)) emit(r, 0);

    wrap.append(this.errorBox);
    this.optionsHost.replaceChildren(wrap);
  }

  /**
   * A custom layer's pictures as one flat list when every group is one picture (a set of hairstyles dragged in
   * together), else null (groups with several options each: group row + option row).
   */
  private flatLayerOptions(r: CtRegion): Array<{ id: string; label: string; image?: string; swatch?: string }> | null {
    const groups = regionGroups(r, this.tpl.items, this.tpl.assets);
    if (!groups.every((g) => g.options.length === 1)) return null;
    const label = r.config.image.label || r.name;
    return groups.map((g) => ({ id: g.options[0].id, label: customerOptionName(g.options[0].name || g.name, label), image: g.options[0].meta.thumb ?? g.options[0].url, swatch: g.options[0].meta.swatch }));
  }

  /** The form fields of one zone (none for a fixed text / a one-picture layer). */
  private regionFields(r: CtRegion): HTMLElement[] {
    const tpl = this.tpl;
    const sel = this.selection[r.id];
    if (r.kind === "image") {
      if (this.isFixedLayer(r)) return [];
      const current = sel?.kind === "image" ? sel.assetId : null;
      const flat = this.flatLayerOptions(r);
      if (flat) {
        return [
          this.field(
            r.config.image.label || r.name,
            this.picker(r.config.image.display, flat, current, r.config.image.allowNone, (id) => this.change(r.id, { kind: "image", assetId: id })),
            !r.config.image.allowNone,
            flat.find((o) => o.id === current)?.label,
          ),
        ];
      }
      const groups = regionGroups(r, tpl.items, tpl.assets);
      const at = locateOption(groups, current);
      const group = groups[Math.max(0, at.group)];
      const out: HTMLElement[] = [];
      if (groups.length > 1) {
        out.push(
          this.field(
            r.config.image.groupLabel,
            this.picker(
              r.config.image.groupDisplay,
              groups.map((g) => ({ id: g.item.id, label: customerOptionName(g.name, r.config.image.groupLabel), image: g.options[0].meta.thumb ?? g.options[0].url, swatch: g.options[0].meta.swatch })),
              group.item.id,
              false,
              (id) => {
                const gi = groups.findIndex((g) => g.item.id === id);
                this.change(r.id, { kind: "image", assetId: optionInGroup(groups, gi, current) });
              },
            ),
            true,
            customerOptionName(group.name, r.config.image.groupLabel),
          ),
        );
      }
      out.push(
        this.field(
          r.config.image.label || r.name,
          this.picker(
            r.config.image.display,
            group.options.map((o) => ({ id: o.id, label: customerOptionName(o.name, r.config.image.label || r.name), image: o.meta.thumb ?? o.url, swatch: o.meta.swatch })),
            current,
            r.config.image.allowNone,
            (id) => this.change(r.id, { kind: "image", assetId: id }),
          ),
          !r.config.image.allowNone,
          current ? customerOptionName(group.options.find((o) => o.id === current)?.name ?? "", r.config.image.label || r.name) || undefined : undefined,
        ),
      );
      return out;
    }
    if (r.kind === "text") {
      const mode = textMode(r);
      const tsel = sel?.kind === "text" ? sel : null;
      // "options": the options ARE the field (each draws its own text and may open child zones).
      if (mode === "options") return [this.zoneOptionsField(r, tsel, true)].filter((x): x is HTMLElement => x !== null);
      const main = mode === "fixed" ? null : this.textField(r, tsel?.text ?? "");
      return [main, this.zoneOptionsField(r, tsel, false)].filter((x): x is HTMLElement => x !== null);
    }
    const psel = sel?.kind === "photo" ? sel : null;
    return [this.photoField(r, psel), this.zoneOptionsField(r, psel, false)].filter((x): x is HTMLElement => x !== null);
  }

  /** Id of a zone's own look in its sub-option picker. */
  private static baseOption(r: CtRegion): string {
    return `${r.id}:base`;
  }

  /**
   * A text / photo zone's options: its own look first, then the others, like a main version's. `primary` (text
   * mode "options"): the zone's only field, under its label; else a second row ("Choose color").
   */
  private zoneOptionsField(r: CtRegion, sel: CtTextSelection | CtPhotoSelection | null, primary: boolean): HTMLElement | null {
    const o = r.config.options;
    if (!o.list.length && !primary) return null;
    const baseId = Customizer.baseOption(r);
    const current = sel?.optionId && o.list.some((x) => x.id === sel.optionId) ? sel.optionId : baseId;
    const list: PickerOption[] = [
      { id: baseId, label: o.baseName || this.t("default", "Default"), swatch: o.baseSwatch },
      ...o.list.map((x) => ({ id: x.id, label: x.name || this.t("option", "Option"), swatch: x.swatch })),
    ];
    return this.field(
      primary ? r.config.text.label || r.name : o.label,
      this.picker(o.display === "image" ? "button" : o.display, list, current, false, (id) => {
        const cur = this.selection[r.id] ?? (r.kind === "text" ? { kind: "text" as const, text: "" } : undefined);
        if (!id || (cur?.kind !== "text" && cur?.kind !== "photo")) return;
        this.change(r.id, { ...cur, optionId: id === baseId ? null : id });
      }),
      true,
      list.find((x) => x.id === current)?.label,
    );
  }

  private field(label: string, control: HTMLElement, required: boolean, valueLabel?: string): HTMLElement {
    const head = el("div", { class: "ct-field__label" }, [label]);
    if (required) head.append(el("span", { class: "ct-required", text: "*" }));
    if (valueLabel) head.append(el("span", { class: "ct-field__value", text: valueLabel }));
    return el("div", { class: "ct-field" }, [head, control]);
  }

  private picker(
    display: CtOptionDisplay,
    options: PickerOption[],
    value: string | null,
    allowNone: boolean,
    onChange: (id: string | null) => void,
  ): HTMLElement {
    if (display === "dropdown") {
      const select = el("select", { class: "ct-select" });
      if (allowNone) select.append(el("option", { value: "", text: this.t("none", "None"), selected: value === null }));
      else if (value === null) select.append(el("option", { value: "", text: this.t("select", "--Select an option--"), selected: true, disabled: true }));
      for (const o of options) select.append(el("option", { value: o.id, text: o.label, selected: o.id === value }));
      select.addEventListener("change", () => onChange(select.value || null));
      return el("div", { class: "ct-select-wrap" }, [select]);
    }
    const list = el("div", { class: `ct-choices ct-choices--${display}`, role: "radiogroup" });
    const add = (id: string | null, content: Node | string, label: string, style?: string) => {
      const b = el("button", { type: "button", class: "ct-choice", role: "radio", "aria-checked": String(id === value), "aria-label": label, title: label, style }, [content]);
      if (id === value) b.classList.add("is-selected");
      b.addEventListener("click", () => onChange(id));
      list.append(b);
    };
    if (allowNone) add(null, el("span", { class: "ct-choice__none", text: "NO" }), this.t("none", "None"));
    // A clipart's name is "<layer> · <option>" ("Theme · Christmas"): a button says only the option.
    // Labels come cleaned (customerOptionName); a leftover "a · b" shows its last part on a small button.
    const short = (x: string) => (x.includes(" · ") ? x.slice(x.lastIndexOf(" · ") + 3) : x);
    for (const o of options) {
      if (display === "button") add(o.id, el("span", { class: "ct-choice__text", text: short(o.label) }), o.label);
      else if (display === "swatch" && o.swatch) add(o.id, el("span", { class: "ct-choice__swatch", style: `background:${o.swatch}` }), o.label);
      else if (!o.image) add(o.id, el("span", { class: "ct-choice__text", text: short(o.label) }), o.label);
      else {
        // The part cropped and centred in its tile (lib/option-thumb.ts) once it is read; the file until then.
        const img = el("img", { src: o.image, alt: o.label, loading: "lazy" });
        const src = o.image;
        void optionThumb(src).then((t) => {
          if (img.getAttribute("src") === src) img.setAttribute("src", t);
        });
        add(o.id, img, o.label);
      }
    }
    return list;
  }

  private textField(r: CtRegion, text: string): HTMLElement {
    const cfg = r.config.text;
    const choices = cfg.choices.filter(Boolean);
    if (choices.length > 0) {
      return this.field(
        cfg.label,
        this.picker("dropdown", choices.map((c) => ({ id: c, label: c })), text || null, false, (v) => {
          const prev = this.selection[r.id];
          if (v !== null) this.change(r.id, { kind: "text", text: v, optionId: prev?.kind === "text" ? prev.optionId : null });
        }),
        true,
      );
    }
    const date = cfg.format === "date";
    const max = date ? 10 : cfg.maxChars;
    const counter = el("span", { class: "ct-counter", text: date ? "dd/mm/yyyy" : `${text.length}/${max}` });
    const input = el("input", { class: "ct-input", type: "text", value: text, maxlength: String(max), placeholder: date ? cfg.placeholder || "dd/mm/yyyy" : cfg.placeholder });
    if (date) input.setAttribute("inputmode", "numeric");
    input.addEventListener("input", () => {
      if (date) input.value = formatDateInput(input.value);
      // Not via change(): re-rendering the form would steal focus mid-typing.
      const prev = this.selection[r.id];
      this.selection = { ...this.selection, [r.id]: { kind: "text", text: input.value, optionId: prev?.kind === "text" ? prev.optionId : null } };
      if (!date) counter.textContent = `${input.value.length}/${max}`;
      this.errorBox.hidden = true;
      this.showStage();
      this.syncTasks();
    });
    return this.field(cfg.label, el("div", { class: "ct-input-wrap" }, [input, counter]), true);
  }

  private photoField(r: CtRegion, sel: CtPhotoSelection | null): HTMLElement {
    const cfg = r.config.photo;
    const body = el("div", { class: "ct-photo" });
    if (sel?.url) {
      body.append(el("img", { class: "ct-photo__thumb", src: sel.url, alt: "" }));
      const edit = el("button", { type: "button", class: "ct-btn ct-btn--ghost", text: this.t("editPhoto", "Edit photo") });
      edit.addEventListener("click", () => this.openPhotoDialog(r, sel));
      body.append(edit);
    } else {
      const up = el("button", { type: "button", class: "ct-btn ct-btn--upload", text: cfg.label || this.t("upload", "Upload your photo") });
      up.addEventListener("click", () => this.openPhotoDialog(r, null));
      body.append(up);
    }
    const styleName = cfg.styles.length > 1 && sel?.url ? styleLabel(sel.style, this.tpl.aiStyles) : undefined;
    const photo = this.field(cfg.label, body, cfg.required, styleName);
    if (!cfg.styles.some((id) => this.aiStyleInfo(id)?.askName === true)) return photo;
    // The name a style writes in the picture ([NAME] in its prompt / its tick), asked on the form before the upload
    // (asked 2026-11-11); the photo dialog shows the same value. Changed after the photo is made: drawn again with it.
    const input = el("input", {
      class: "ct-input ct-input--plain",
      type: "text",
      maxlength: "40",
      value: this.photoNames.get(r.id) ?? "",
      placeholder: this.t("photoNamePlaceholder", "Enter a name (optional)"),
    });
    input.addEventListener("input", () => this.photoNames.set(r.id, input.value));
    input.addEventListener("change", () => {
      this.photoNames.set(r.id, input.value);
      const now = this.selection[r.id];
      if (now?.kind !== "photo" || !now.url || !now.style || this.aiStyleInfo(now.style)?.askName !== true) return;
      const name = input.value.replace(/\s+/g, " ").trim().slice(0, 40);
      if ((this.nameOfPhoto.get(now.url) ?? "") !== name) this.openPhotoDialog(r, now, true);
    });
    return el("div", { class: "ct-photo-group" }, [this.field(this.t("photoName", "Name"), input, false), photo]);
  }

  // ------------------------------------------------------------- photo tasks (server/photo-tasks.ts)
  /**
   * An AI style goes through a server task (2026-11-09): style → finished photo → (with the deploy's "Phôi AI có ảnh
   * khách" tick) the phôi drawn with it, all on the server, so the customer may leave and come back (storefront/tasks.ts).
   * 2026-11-10: the task, its loader, "Buy More" and the persisted card stay whether the tick is on or off.
   */
  private usesTasks(r: CtRegion, style: CtPhotoStyleRef): boolean {
    return !this.previewMode && r.config.photo.cutout && isAiStyleRef(style);
  }

  private get tasksUrl(): string {
    return this.photoUrl.replace("/public/photo/", "/public/tasks/");
  }

  /** The design to bring back with a task: everything but that photo zone (texts included). */
  private snapshot(regionId: string): CtSelection {
    const out: CtSelection = {};
    for (const [id, sel] of Object.entries(this.selection)) {
      if (id === regionId) continue;
      if (sel.kind === "photo" && sel.url?.startsWith("blob:")) continue;
      out[id] = sel;
    }
    return out;
  }

  /** The published AI style's flags (askName); undefined for a built-in style. */
  private aiStyleInfo(style: CtPhotoStyleRef): CtPublicAiStyle | undefined {
    return this.tpl.aiStyles?.find((x) => x.ref === style);
  }

  private async startPhotoTask(r: CtRegion, source: Blob, style: CtPhotoStyleRef, optionId: string | null, name: string): Promise<CtStoredTask> {
    const blob = await shrinkImage(source, 1600);
    const body = new FormData();
    body.append("file", blob, blob.type === "image/png" ? "photo.png" : "photo.jpg");
    body.append("region", r.id);
    body.append("style", style);
    body.append("cutout", "1");
    body.append("mainId", selectedMainId(this.selection, this.tpl.assets, this.tpl.mainAssetId));
    body.append("selection", JSON.stringify(phoiPicks(this.selection)));
    if (optionId) body.append("optionId", optionId);
    if (name) body.append("name", name);
    const res = await fetch(this.tasksUrl, { method: "POST", body, mode: "cors" });
    const json = (await res.json().catch(() => ({}))) as { task?: CtPhotoTask; error?: string };
    if (!res.ok || !json.task) throw new Error(json.error ?? `HTTP ${res.status}`);
    const og = document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content ?? "";
    const stored: CtStoredTask = {
      id: json.task.id,
      poll: this.tasksUrl.replace(/[^/]+$/, json.task.id),
      // The page as opened (a preview link needs its query), without a task to restore.
      productUrl: ((u) => (u.searchParams.delete(TASK_PARAM), u.pathname + u.search))(new URL(location.href)),
      productTitle: this.root.dataset.ctProductTitle || document.title,
      productImage: this.root.dataset.ctProductImage || og,
      styleName: styleLabel(style, this.tpl.aiStyles),
      selection: this.snapshot(r.id),
      transform: { ...IDENTITY_TRANSFORM },
      optionId,
      task: json.task,
      createdAt: Date.now(),
    };
    addTask(stored);
    return stored;
  }

  /** The finished photo of a task (it goes on drawing its phôi after). */
  private taskPhoto(id: string): Promise<string> {
    return this.untilTask(id, (t) => (t.photoUrl ? t.photoUrl : null));
  }

  /**
   * The task's photo once ALL of it is done — the phôi too (2026-11-10: the customer sees the acrylic piece at once,
   * not the flat photo first). A phôi that could not be drawn still gives the photo (its error stays on the task).
   */
  private taskResult(id: string, onStage?: (stage: CtPhotoTask["stage"]) => void): Promise<string> {
    let last: CtPhotoTask["stage"] | null = null;
    return this.untilTask(id, (t) => {
      if (t.stage !== last) {
        last = t.stage;
        onStage?.(t.stage);
      }
      return t.photoUrl && !taskWorking(t) ? t.photoUrl : null;
    });
  }

  /** The phôi `key` of a task drawn (resolves) or given up (rejects with why). */
  private waitPhoi(id: string, key: string): Promise<string> {
    return this.untilTask(id, (t) => {
      if (t.phoi?.key === key) return t.phoi.url;
      if (t.phoiPending !== key) throw new Error(t.error || this.t("phoiFailed", "We couldn't update the preview — please try again."));
      return null;
    });
  }

  /** Resolves with `done(task)` once it is not null; a failed / forgotten task (or `done` throwing) rejects. */
  private untilTask<T>(id: string, done: (t: CtPhotoTask) => T | null): Promise<T> {
    return new Promise((resolve, reject) => {
      let off: () => void = () => undefined;
      let settled = false;
      const end = () => {
        settled = true;
        off();
      };
      const check = () => {
        if (settled) return;
        const t = getTask(id)?.task;
        try {
          const out = t && t.stage !== "failed" ? done(t) : null;
          if (out !== null) {
            end();
            if (t?.photoUrl) this.taskByPhoto.set(t.photoUrl, id);
            resolve(out);
          } else if (!t || t.stage === "failed") {
            end();
            reject(new Error(t?.error || this.t("taskFailed", "We couldn't finish this photo — please try again.")));
          }
        } catch (e) {
          end();
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      };
      off = onTasks(check);
      check();
    });
  }

  /**
   * The customer left the dialog before the photo was ready ("Keep browsing"), or the page was reloaded meanwhile:
   * it goes in by itself when it is, as big as its zone allows — unless they put another photo there meanwhile.
   */
  private autoApply(r: CtRegion, id: string, style: CtPhotoStyleRef, optionId: string | null, design = this.active): void {
    this.waitingTask = id;
    this.scheduleRender();
    void this.taskPhoto(id)
      .then((url) => {
        if (this.destroyed) return;
        const sel = this.designs[design];
        const cur = sel?.[r.id];
        if (!sel || (cur?.kind === "photo" && cur.url && cur.url !== url)) return;
        const stored = getTask(id);
        const value: CtPhotoSelection = { kind: "photo", url, transform: { ...(stored?.transform ?? IDENTITY_TRANSFORM) }, style, sourceUrl: stored?.task.sourceUrl ?? null, optionId };
        if (design === this.active) this.change(r.id, value);
        else this.designs[design] = { ...sel, [r.id]: value };
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.waitingTask !== id) return;
        this.waitingTask = null;
        this.scheduleRender();
      });
  }

  /** After a change: the stored design of each photo task follows it, and the phôi of what is shown is asked for. */
  private syncTasks(): void {
    if (this.previewMode) return;
    const sel = this.selection;
    for (const r of this.regions) {
      const p = sel[r.id];
      if (p?.kind !== "photo" || !p.url) continue;
      const id = this.taskByPhoto.get(p.url);
      if (id) updateTask(id, { selection: this.snapshot(r.id), transform: p.transform, optionId: p.optionId ?? null });
    }
    window.clearTimeout(this.phoiTimer);
    this.phoiTimer = window.setTimeout(() => void this.askPhoi(), 1200);
  }

  /** The photo task of the design shown and the phôi it needs; null = none (no task photo, a version without phôi). */
  private wantedPhoi(sel: CtSelection): { stored: CtStoredTask; key: string; body: object; regionId: string; mainId: string; photo: CtPhotoSelection } | null {
    // Only when the deploy ticked "Phôi AI có ảnh khách" (2026-11-10); off = the photo is laid on the version's phôi.
    if (this.previewMode || !this.taskByPhoto.size || this.tpl.config.customerPhoi !== true) return null;
    const mainId = selectedMainId(sel, this.tpl.assets, this.tpl.mainAssetId);
    if (!this.tpl.config.versionPhoi.some((v) => v.mainId === mainId)) return null;
    for (const r of this.shownRegions(sel)) {
      const p = sel[r.id];
      if (p?.kind !== "photo" || !p.url) continue;
      const id = this.taskByPhoto.get(p.url);
      const stored = id ? getTask(id) : null;
      if (!stored) continue;
      const optionId = p.optionId ?? null;
      return {
        stored,
        key: phoiTaskKey(mainId, r.id, p.transform, sel, optionId),
        body: { mainId, transform: p.transform, selection: phoiPicks(sel), optionId },
        regionId: r.id,
        mainId,
        photo: p,
      };
    }
    return null;
  }

  /** Asks the server for the phôi of `sel` (nothing when it is drawn or being drawn); the key wanted, null = none. */
  private async askPhoi(sel: CtSelection = this.selection): Promise<string | null> {
    const want = this.wantedPhoi(sel);
    if (!want) return null;
    const t = want.stored.task;
    if (!t.photoUrl || t.phoi?.key === want.key || t.phoiPending === want.key) return want.key;
    const res = await fetch(`${want.stored.poll}/phoi`, { method: "POST", mode: "cors", headers: { "Content-Type": "application/json" }, body: JSON.stringify(want.body) }).catch(() => null);
    const json = res ? ((await res.json().catch(() => null)) as { task?: CtPhotoTask; error?: string } | null) : null;
    if (json?.task) updateTask(want.stored.id, { task: json.task });
    else throw new Error(json?.error || this.t("phoiFailed", "We couldn't update the preview — please try again."));
    return want.key;
  }

  /** A customer phôi with the typed texts laid on it, `side` px. */
  private async phoiCanvas(phoi: CtPhotoTaskPhoi, sel: CtSelection, side: number): Promise<HTMLCanvasElement> {
    const k = Math.min(1, side / Math.max(phoi.width, phoi.height));
    const scale = Math.min(1, (phoi.box.w * k) / this.main.width);
    const texts = this.regions.filter((r) => r.kind === "text");
    const input = { main: this.main, assets: this.tpl.assets, regions: texts, items: this.tpl.items, selection: sel, layouts: this.tpl.config.layouts };
    const c = await renderComposite({ ...input, scale: Math.max(scale, 0.05), display: true, part: "dynamic" });
    return drawOnScene({ url: phoi.url, width: phoi.width, height: phoi.height, box: phoi.box }, c, side, { x: 0, y: 0 }, true);
  }

  private onTasksChanged(): void {
    if (this.waitingTask || this.wantedPhoi(this.selection)) this.scheduleRender();
  }

  private showBadge(on: boolean, text = ""): void {
    if (!this.stage) return;
    if (on && !this.badge) {
      this.badge = el("div", { class: "ct-stage__badge", role: "status" }, [el("span", { class: "ct-stage__badge-dot" }), el("span", { class: "ct-stage__badge-text" })]);
      this.stage.append(this.badge);
    }
    if (!this.badge) return;
    this.badge.hidden = !on;
    const label = this.badge.querySelector(".ct-stage__badge-text");
    if (on && label && label.textContent !== text) label.textContent = text;
  }

  /**
   * ?flexi2_task=<id> (a card of storefront/tasks.ts), else the newest task of this product (2026-11-10: a reload,
   * Shift+R, coming back later — the design and its preview are still there): its design filled in again.
   */
  private restoreTask(): void {
    const url = new URL(location.href);
    const fromLink = url.searchParams.get(TASK_PARAM);
    if (fromLink) {
      url.searchParams.delete(TASK_PARAM);
      history.replaceState(history.state, "", url.toString());
    }
    const stored = fromLink ? getTask(fromLink) : latestForPage();
    const r = stored ? this.regions.find((x) => x.id === stored.task.regionId && x.kind === "photo") : undefined;
    if (!stored || !r) return;
    const id = stored.id;
    const style = stored.task.style as CtPhotoStyleRef;
    const sel = this.carryOver({ ...stored.selection });
    const photoUrl = stored.task.photoUrl;
    if (photoUrl) {
      this.taskByPhoto.set(photoUrl, id);
      sel[r.id] = { kind: "photo", url: photoUrl, transform: stored.transform, style, sourceUrl: stored.task.sourceUrl, optionId: stored.optionId };
    }
    this.selection = sel;
    this.renderOptions();
    this.showStage();
    if (!photoUrl) this.autoApply(r, id, style, stored.optionId);
    else this.syncTasks();
    if (!stored.notified && !taskWorking(stored.task)) updateTask(id, { notified: true });
  }

  /**
   * What to look at while the AI works (2026-11-10: "list các sản phẩm tương tự cùng collections"): the products of
   * this product's collections, else Shopify's own suggestions.
   */
  private loadRecos(): Promise<CtRecoProduct[]> {
    const base = (window as CtShopifyWindow).Shopify?.routes?.root ?? "/";
    const self = this.root.dataset.ctProductHandle ?? "";
    const handles = (this.root.dataset.ctCollections ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter((h) => h && h !== "all" && h !== "frontpage")
      .slice(0, 3);
    const fromCollections = (): Promise<CtRecoProduct[]> =>
      Promise.all(
        handles.map((h) =>
          fetch(`${base}collections/${encodeURIComponent(h)}/products.json?limit=24`)
            .then((r) => (r.ok ? (r.json() as Promise<{ products?: CtCollectionProduct[] }>) : { products: [] }))
            .catch(() => ({ products: [] as CtCollectionProduct[] })),
        ),
      ).then((lists) => {
        const seen = new Set<string>([self]);
        const out: CtRecoProduct[] = [];
        for (const p of lists.flatMap((l) => l.products ?? [])) {
          const img = p.images?.[0]?.src;
          if (seen.has(p.handle) || !img) continue;
          seen.add(p.handle);
          const price = Number.parseFloat(p.variants?.[0]?.price ?? "");
          const available = (p.variants ?? []).some((v) => v.available !== false);
          out.push({ title: p.title, url: `${base}products/${p.handle}`, featured_image: img, available, price: Number.isFinite(price) ? Math.round(price * 100) : undefined });
        }
        // Availability follows the visitor's market: the ones they can buy first, never an empty list because of it.
        return out.sort((a, b) => Number(b.available) - Number(a.available)).slice(0, 12);
      });
    const fromShopify = (): Promise<CtRecoProduct[]> => {
      const id = this.root.dataset.ctShopifyProductId;
      if (!id) return Promise.resolve([]);
      return fetch(`${base}recommendations/products.json?product_id=${encodeURIComponent(id)}&limit=10&intent=related`)
        .then((r) => (r.ok ? (r.json() as Promise<{ products?: CtRecoProduct[] }>) : { products: [] }))
        .then((j) => (j.products ?? []).filter((p) => !!p.featured_image).sort((a, b) => Number(b.available !== false) - Number(a.available !== false)))
        .catch(() => []);
    };
    this.recos ??= fromCollections().then((list) => (list.length ? list : fromShopify()));
    return this.recos;
  }

  /**
   * The wait of an AI style (2026-11-10: "layer loading sẽ là 1 dialog stack trên dialog upload ảnh, nửa trên loading
   * như hiện tại, nửa dưới list các sản phẩm tương tự cùng collections"): a second dialog over the photo dialog.
   * In the background (a server task) "Keep browsing" leaves; else the products open in a new tab and "Cancel" stops
   * waiting.
   */
  private waitDialog(magic: MagicLoader, on: { keep: () => void; cancel: () => void }): { show: (background: boolean) => void; hide: () => void; remove: () => void } {
    const dialog = el("dialog", { class: "ct-dialog ct-waitdlg" });
    dialog.style.setProperty("--ct-accent", getComputedStyle(this.root).getPropertyValue("--ct-accent"));
    const top = el("div", { class: "ct-waitdlg__top" });
    const text = el("p", { class: "ct-wait__text" });
    const keep = el("button", { type: "button", class: "ct-btn ct-btn--primary ct-wait__keep", text: this.t("keepBrowsing", "Buy More") });
    const cancel = el("button", { type: "button", class: "ct-btn ct-btn--ghost ct-wait__keep", text: this.t("cancel", "Cancel") });
    keep.addEventListener("click", on.keep);
    cancel.addEventListener("click", on.cancel);
    const label = el("div", { class: "ct-wait__label", text: this.t("moreLikeThis", "More from this collection"), hidden: true });
    const grid = el("div", { class: "ct-waitdlg__grid" });
    dialog.append(top, el("div", { class: "ct-waitdlg__bottom" }, [el("div", { class: "ct-wait__head" }, [text, keep, cancel]), label, grid]));
    // Esc never drops the wait (the buttons say what happens).
    dialog.addEventListener("cancel", (e) => e.preventDefault());
    const money = this.root.dataset.ctMoneyFormat || "${{amount}}";
    let background = false;
    const fill = (products: CtRecoProduct[]) => {
      label.hidden = !products.length;
      const src = (u: string) => (u.startsWith("//") ? `https:${u}` : u);
      grid.replaceChildren(
        ...products.map((p) =>
          el("a", { class: "ct-wait__card", href: p.url, target: background ? undefined : "_blank", rel: background ? undefined : "noopener" }, [
            el("img", { src: src(p.featured_image), alt: "", loading: "lazy" }),
            el("span", { class: "ct-wait__name", text: p.title }),
            ...(typeof p.price === "number" ? [el("span", { class: "ct-wait__price", text: formatMoney(p.price, money) })] : []),
          ]),
        ),
      );
    };
    return {
      show: (bg) => {
        background = bg;
        text.textContent = bg
          ? this.t("waitText", "This takes a minute or two. Feel free to buy more — it carries on in the background and pops up in the corner when it's ready.")
          : this.t("waitTextHere", "This takes about a minute. Meanwhile, have a look at these (they open in a new tab).");
        keep.hidden = !bg;
        cancel.hidden = bg;
        top.append(magic.root);
        if (!dialog.isConnected) document.body.append(dialog);
        if (!dialog.open) dialog.showModal();
        void this.loadRecos().then(fill);
      },
      hide: () => {
        if (dialog.open) dialog.close();
      },
      remove: () => dialog.remove(),
    };
  }

  // ------------------------------------------------------------- photo dialog
  /**
   * Upload → pick a style (round swatches: a Face zone's "Filter" row shows the face with every filter) → place the
   * photo on the real product render (material version) by hand: drag to move, a corner to resize, the round handle
   * to rotate, pinch / wheel to zoom — like the editor's frame. → Apply. Renders are made once per style and kept
   * for the dialog's lifetime; files upload when the customer applies, so Add to cart does not wait on them.
   */
  /** redraw: the photo is drawn again at once (a new name typed on the form). */
  private openPhotoDialog(r: CtRegion, current: CtPhotoSelection | null, redraw = false): void {
    const cfg = r.config.photo;
    const dialog = el("dialog", { class: "ct-dialog", "data-ct-owner": this.root.id || undefined });
    // The dialog lives on <body>, outside the section that sets the accent.
    dialog.style.setProperty("--ct-accent", getComputedStyle(this.root).getPropertyValue("--ct-accent"));
    const canvas = el("canvas", { class: "ct-dialog__canvas" });
    // 2026-11-10: the upload button opens the dialog only; the photo is chosen here (a tap, or dropped on it).
    const empty = el("button", { type: "button", class: "ct-dialog__drop" }, [
      el("strong", { text: this.t("choosePhoto", "Choose photo") }),
      el("span", { text: this.t("dropPhoto", "JPG or PNG · or drop it here") }),
    ]);
    // The wait: a sky of RGB-twinkling constellations and the store's name shimmering (storefront/magic-loader.ts).
    const magic = createMagicLoader(this.t("magic", "Cherivia magic"));
    const busy = magic.root;
    const stageBox = el("div", { class: "ct-dialog__stage" }, [canvas, empty, busy]);
    const file = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp", hidden: true });
    const pick = el("button", { type: "button", class: "ct-btn ct-btn--ghost", text: this.t("choosePhoto", "Choose photo") });
    const hint = el("span", { class: "ct-dialog__hint", text: this.t("placeHint", "Drag to move · corner to resize · ↻ to rotate") });
    // On the realistic piece (a task's phôi) the photo is not dragged: "Adjust position" shows the flat design to place
    // it, "Done" draws the piece again with it there.
    const adjust = el("button", { type: "button", class: "ct-btn ct-btn--ghost", text: this.t("adjust", "Adjust position"), hidden: true });
    const apply = el("button", { type: "button", class: "ct-btn ct-btn--primary", text: this.t("apply", "Apply") });
    const cancel = el("button", { type: "button", class: "ct-btn ct-btn--ghost", text: this.t("cancel", "Cancel") });
    const status = el("span", { class: "ct-dialog__status" });

    let style: CtPhotoStyleRef = current?.style && cfg.styles.includes(current.style) ? current.style : cfg.defaultStyle;
    // The zone's sub-option (frame shape) picked outside the dialog stays.
    const picked = this.selection[r.id];
    const optionId = picked?.kind === "photo" ? (picked.optionId ?? null) : null;
    let sourceUrl = current?.sourceUrl ?? current?.url ?? null;
    let photoUrl = current?.url ?? null;
    let t: CtTransform = { ...(current?.transform ?? IDENTITY_TRANSFORM) };
    let source: Blob | null = sourceUrl ? (this.localBlobs.get(sourceUrl) ?? null) : null;
    let renders = new Map<CtPhotoStyleRef, Promise<string>>();
    if (photoUrl && current?.style === style && !redraw) renders.set(style, Promise.resolve(photoUrl));
    /** Blob URLs made by this dialog; the ones not applied are freed on close. */
    const made = new Set<string>();
    let job = 0;
    /** Style → the server task drawing it (usesTasks). */
    const taskOf = new Map<CtPhotoStyleRef, string>();
    /** The flat design with handles (placing the photo) instead of the task's realistic piece. */
    let placing = false;
    /** The canvas shows the task's phôi now (no handles, nothing to drag). */
    let showingPhoi = false;
    /** What "Keep browsing" leaves running: a style's task (its photo goes in when ready) or a new placement's piece. */
    let leaving: "task" | "placement" = "task";
    const dialogSel = (): CtSelection => ({ ...this.selection, [r.id]: { kind: "photo", url: photoUrl, transform: t, style, sourceUrl, optionId } });

    const keep = (blob: Blob): string => {
      const url = URL.createObjectURL(blob);
      this.localBlobs.set(url, blob);
      made.add(url);
      return url;
    };
    const blobOf = async (url: string): Promise<Blob> => this.localBlobs.get(url) ?? (await fetch(url).then((res) => res.blob()));

    // ---- style swatches (round, the photo in each style once it is ready)
    const swatches = new Map<CtPhotoStyleRef, HTMLButtonElement>();
    const styleRow = el("div", { class: "ct-filters", role: "radiogroup" });
    // An AI style shows its demo picture (the style on a sample pet) until the customer's own photo is drawn in it.
    const demoOf = (id: CtPhotoStyleRef) => this.tpl.aiStyles?.find((x) => x.ref === id)?.demoUrl;
    const emptyDot = (id: CtPhotoStyleRef): HTMLElement => {
      const demo = demoOf(id);
      return demo ? el("img", { src: demo, alt: "" }) : el("span", { class: "ct-filter__initial", text: styleLabel(id, this.tpl.aiStyles).slice(0, 1) });
    };
    for (const id of cfg.styles) {
      const label = styleLabel(id, this.tpl.aiStyles);
      const b = el("button", { type: "button", class: demoOf(id) ? "ct-filter ct-filter--demo" : "ct-filter", role: "radio", title: label }, [
        el("span", { class: "ct-filter__dot" }, [emptyDot(id)]),
        el("span", { class: "ct-filter__label", text: label }),
      ]);
      b.addEventListener("click", () => void show(id));
      swatches.set(id, b);
      styleRow.append(b);
    }
    // ---- the customer's name, for a style that writes it in the picture (askName, asked 2026-11-11)
    const nameInput = el("input", {
      class: "ct-input",
      type: "text",
      maxlength: "40",
      value: this.photoNames.get(r.id) ?? "",
      placeholder: this.t("photoNamePlaceholder", "Enter a name (optional)"),
    });
    const nameRow = el("label", { class: "ct-dialog__name" }, [el("span", { class: "ct-dialog__style-label", text: this.t("photoName", "Name") }), nameInput]);
    const asksName = (id: CtPhotoStyleRef) => this.aiStyleInfo(id)?.askName === true;
    const nameFor = (id: CtPhotoStyleRef) => (asksName(id) ? nameInput.value.replace(/\s+/g, " ").trim().slice(0, 40) : "");
    const markStyle = () => {
      for (const [id, b] of swatches) {
        b.classList.toggle("is-selected", id === style);
        b.setAttribute("aria-checked", String(id === style));
      }
      nameRow.hidden = !asksName(style);
    };
    const setThumb = (id: CtPhotoStyleRef, url: string) => {
      const dot = swatches.get(id)?.querySelector(".ct-filter__dot");
      dot?.replaceChildren(el("img", { src: url, alt: "" }));
    };
    const clearThumbs = () => {
      for (const [id, b] of swatches) b.querySelector(".ct-filter__dot")?.replaceChildren(emptyDot(id));
    };
    /** Cheap styles (Face filters, local ones) get their thumbnail as soon as their base is ready. */
    const warmThumbs = () => {
      for (const id of cfg.styles) {
        const cheap = styleFamily(id) === "face" || styleEngine(id) !== "server" || renders.has(id);
        if (!cheap) continue;
        void render(id)
          .then((url) => setThumb(id, url))
          .catch(() => undefined);
      }
    };

    // ---- geometry: where the photo sits (main px) and how the view maps to it
    let view = { k: 1, bx: 0, by: 0 };
    let imgSize: { w: number; h: number } | null = null;
    const layout = layoutFor(this.tpl.config.layouts, selectedMainId(this.selection, this.tpl.assets, this.tpl.mainAssetId));
    const zoneNow = () => regionForSelection({ ...r, shape: layout?.regions[r.id]?.shape ?? r.shape }, { kind: "photo", url: null, transform: t, optionId });
    const geom = () => {
      if (!imgSize) return null;
      const zone = zoneNow();
      const bounds = shapeBounds(zone.shape);
      const f = photoFrameBox(bounds, resolvePhotoFrame(zone.config.photo, zone.shape, { width: imgSize.w, height: imgSize.h }));
      const m = f.margin;
      const inner = { x: -f.w / 2 + m, y: -f.h / 2 + m, w: Math.max(1, f.w - 2 * m), h: Math.max(1, f.h - 2 * m) };
      const p = itemPlacement(inner, imgSize.w, imgSize.h, t, cfg.fit);
      const fr = (f.rotation * Math.PI) / 180;
      const center = { x: f.cx + p.cx * Math.cos(fr) - p.cy * Math.sin(fr), y: f.cy + p.cx * Math.sin(fr) + p.cy * Math.cos(fr) };
      return { center, w: p.w, h: p.h, rot: f.rotation + t.rotation, frameRot: f.rotation, inner };
    };
    const corners = (g: NonNullable<ReturnType<typeof geom>>) => {
      const a = (g.rot * Math.PI) / 180;
      return [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ].map(([sx, sy]) => {
        const x = (sx * g.w) / 2;
        const y = (sy * g.h) / 2;
        return { x: g.center.x + x * Math.cos(a) - y * Math.sin(a), y: g.center.y + x * Math.sin(a) + y * Math.cos(a) };
      });
    };
    /** Where the picture shows inside the canvas element (object-fit: contain under a max-height). */
    const shownRect = () => {
      const rect = canvas.getBoundingClientRect();
      const s = Math.min(rect.width / Math.max(1, canvas.width), rect.height / Math.max(1, canvas.height));
      const w = canvas.width * s;
      const h = canvas.height * s;
      return { left: rect.left + (rect.width - w) / 2, top: rect.top + (rect.height - h) / 2, s: Math.max(1e-6, s) };
    };
    /** A pointer → main px. */
    const toMain = (e: PointerEvent | WheelEvent) => {
      const r0 = shownRect();
      const cx = (e.clientX - r0.left) / r0.s;
      const cy = (e.clientY - r0.top) / r0.s;
      return { x: cx / view.k - view.bx, y: cy / view.k - view.by };
    };
    /** One screen pixel, in main px. */
    const screenPx = () => 1 / shownRect().s / view.k;
    const rotateHandle = (g: NonNullable<ReturnType<typeof geom>>) => {
      const a = (g.rot * Math.PI) / 180;
      const d = g.h / 2 + 34 * screenPx();
      return { x: g.center.x + d * Math.sin(a), y: g.center.y - d * Math.cos(a) };
    };

    let drawing = false;
    let again = false;
    const draw = async () => {
      if (drawing) {
        again = true;
        return;
      }
      drawing = true;
      try {
        empty.hidden = Boolean(photoUrl);
        imgSize = null;
        if (photoUrl) {
          const img = await loadImage(photoUrl).catch(() => null);
          if (img) imgSize = { w: img.naturalWidth, h: img.naturalHeight };
        }
        const sel = dialogSel();
        // A task's photo: the realistic piece drawn with it (when drawn for this placement).
        const want = photoUrl && !placing ? this.wantedPhoi(sel) : null;
        const ready = want && want.stored.task.phoi?.key === want.key ? want.stored.task.phoi : null;
        const phoiOff = ready ? await this.phoiCanvas(ready, sel, 1000).catch(() => null) : null;
        showingPhoi = !!phoiOff;
        adjust.hidden = !(phoiOff || placing);
        hint.hidden = !!phoiOff;
        if (phoiOff) {
          canvas.width = phoiOff.width;
          canvas.height = phoiOff.height;
          canvas.getContext("2d")?.drawImage(phoiOff, 0, 0);
          canvas.style.cursor = "default";
          return;
        }
        // The product as the customer sees it: material version, plate / cord included (bleed).
        const input = { main: this.main, assets: this.tpl.assets, regions: this.regions, items: this.tpl.items, selection: sel, layouts: this.tpl.config.layouts };
        const b = compositeBleed(input);
        const k = Math.min(1, 1000 / Math.max(this.main.width + 2 * b.x, this.main.height + 2 * b.y));
        const c = await renderComposite({ ...input, scale: k, bleed: true }).catch(() => null);
        if (!c) return;
        view = { k, bx: b.x, by: b.y };
        canvas.width = c.width;
        canvas.height = c.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(c, 0, 0);
        const g = geom();
        if (!g) return;
        // The photo's frame + handles, like the editor's.
        const P = (p: { x: number; y: number }) => ({ x: (p.x + view.bx) * k, y: (p.y + view.by) * k });
        const pts = corners(g).map(P);
        const unit = 1 / shownRect().s;
        const accent = getComputedStyle(dialog).getPropertyValue("--ct-accent").trim() || "#e5793b";
        ctx.save();
        ctx.lineWidth = 1.5 * unit;
        ctx.strokeStyle = accent;
        ctx.setLineDash([6 * unit, 4 * unit]);
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);
        const top = P({ x: (corners(g)[0].x + corners(g)[1].x) / 2, y: (corners(g)[0].y + corners(g)[1].y) / 2 });
        const rh = P(rotateHandle(g));
        ctx.beginPath();
        ctx.moveTo(top.x, top.y);
        ctx.lineTo(rh.x, rh.y);
        ctx.stroke();
        for (const p of [...pts, rh]) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 7 * unit, 0, Math.PI * 2);
          ctx.fillStyle = "#fff";
          ctx.fill();
          ctx.stroke();
        }
        ctx.fillStyle = accent;
        ctx.font = `${12 * unit}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("↻", rh.x, rh.y + 0.5 * unit);
        ctx.restore();
      } finally {
        drawing = false;
        if (again) {
          again = false;
          void draw();
        }
      }
    };

    /** wait: "stage" = the loader over the picture (a quick cut-out), "here" / "background" = the wait dialog on top. */
    const setBusy = (on: boolean, text = "", steps?: string[], wait: "stage" | "here" | "background" = "stage") => {
      if (on) {
        if (wait === "stage") {
          waitDlg.hide();
          stageBox.append(busy);
        } else waitDlg.show(wait === "background");
        magic.show(text, steps);
      } else {
        magic.hide();
        waitDlg.hide();
      }
      apply.disabled = on;
      adjust.disabled = on;
      empty.hidden = on || Boolean(photoUrl);
    };
    const phoiSteps = [
      this.t("phoiStep0", "Crafting your acrylic piece…"),
      this.t("phoiStep1", "Cutting the acrylic around your design…"),
      this.t("phoiStep2", "Polishing the edges and the shine…"),
      this.t("phoiStep3", "Hanging it up for its photo…"),
      this.t("phoiStep4", "Almost there — good things take a moment ✨"),
    ];

    const render = (next: CtPhotoStyleRef): Promise<string> => {
      const cached = renders.get(next);
      if (cached) return cached;
      const src = sourceUrl;
      if (!src) return Promise.reject(new Error("No photo"));
      const engine = styleEngine(next);
      const filter = styleFilter(next);
      const p = this.usesTasks(r, next)
        ? (async () => {
            // The whole chain on the server (style → photo → the phôi with it): it goes on if the customer leaves.
            const blob: Blob = source ?? (await fetch(src).then((res) => res.blob()));
            source = blob;
            const stored = await this.startPhotoTask(r, blob, next, optionId, nameFor(next));
            taskOf.set(next, stored.id);
            // Ready when the acrylic piece is drawn too; the loader's lines follow the task's step.
            return this.taskResult(stored.id, (stage) => {
              if (stage === "phoi" && style === next && !magic.root.hidden) magic.show(phoiSteps[0], phoiSteps);
            });
          })()
        : engine === "none" && !cfg.cutout
          ? Promise.resolve(src) // untouched photo: nothing to compute
          : styleFamily(next) === "face" && filter
            ? // Every Face filter is the one "Real face" cut, coloured in the browser — the server works once.
              (async () => keep(await filterBlob(await blobOf(await render("face")), filter)))()
            : engine === "local" && cfg.cutout
              ? (async () => {
                  // Local filters run on the cut-out "Real photo", so the server is asked only once.
                  const base = await blobOf(await render("original"));
                  return keep(await processPhoto({ source: base, style: next, cutout: false, endpoint: this.photoUrl }));
                })()
              : (async () => {
                  const blob: Blob = source ?? (await fetch(src).then((res) => res.blob()));
                  source = blob;
                  const name = nameFor(next);
                  const centerOn = isAiStyleRef(next) ? faceTargets(this.tpl.config.print, shapeBounds(zoneNow().shape)) : null;
                  return keep(await processPhoto({ source: blob, style: next, cutout: cfg.cutout, fadeCrop: cfg.fadeCrop, centerOn, endpoint: this.photoUrl, fields: { region: r.id, ...(name ? { name } : {}) } }));
                })();
      renders.set(next, p);
      p.catch(() => renders.delete(next));
      return p;
    };

    const show = async (next: CtPhotoStyleRef) => {
      style = next;
      markStyle();
      if (!sourceUrl) return;
      const token = ++job;
      status.textContent = "";
      // Anything not rendered yet shows the spinner; the untouched upload is never drawn in the frame.
      if (!renders.has(next)) {
        const cutoutOnly = cfg.cutout && (next === "original" || (styleEngine(next) === "local" && !renders.has("original")));
        const faceFirst = styleFamily(next) === "face" && !renders.has("face");
        const ai = !cutoutOnly && !faceFirst && styleEngine(next) === "server";
        const name = styleLabel(next, this.tpl.aiStyles);
        // An AI redraw takes 30–60 s: the line keeps changing so it never looks stuck.
        const steps = ai
          ? [
              `${this.t("creating", "Creating")} ${name}…`,
              this.t("magicStep1", "Studying every little detail of your photo…"),
              this.t("magicStep2", "Sketching the outline by hand…"),
              this.t("magicStep3", "Painting colours and textures…"),
              this.t("magicStep4", "Adding the finishing sparkle…"),
              this.t("magicStep5", "Almost there — good things take a moment ✨"),
            ]
          : undefined;
        setBusy(
          true,
          cutoutOnly || faceFirst ? this.t("removingBg", "Removing background…") : `${this.t("creating", "Creating")} ${name}…`,
          steps,
          // The editor preview shows the store's wait too (2026-11-10): Buy More, the products below.
          !ai ? "stage" : this.usesTasks(r, next) || this.previewMode ? "background" : "here",
        );
        leaving = "task";
      }
      try {
        const url = await render(next);
        if (asksName(next)) this.nameOfPhoto.set(url, nameFor(next));
        if (token !== job) return;
        photoUrl = url;
        placing = false;
        setThumb(next, url);
        await draw();
        warmThumbs();
        const tid = this.taskByPhoto.get(url);
        const err = tid ? getTask(tid)?.task.error : null;
        if (err) status.textContent = err;
      } catch (e) {
        if (token !== job) return;
        status.textContent = e instanceof Error ? e.message : String(e);
      } finally {
        if (token === job) setBusy(false);
      }
    };

    pick.addEventListener("click", () => file.click());
    empty.addEventListener("click", () => file.click());
    const useFile = (f: File) => {
      if (!/^image\/(png|jpeg|webp)$/.test(f.type)) {
        status.textContent = this.t("badFile", "Please choose a JPG, PNG or WEBP photo.");
        return;
      }
      source = f;
      sourceUrl = keep(f);
      renders = new Map();
      clearThumbs();
      t = { ...IDENTITY_TRANSFORM };
      pick.textContent = this.t("changePhoto", "Change photo");
      // The frame stays empty behind the spinner until the processed photo (cut-out + style) is ready.
      photoUrl = null;
      placing = false;
      void draw();
      void show(style);
    };
    file.addEventListener("change", () => {
      const f = file.files?.[0];
      file.value = "";
      if (f) useFile(f);
    });
    stageBox.addEventListener("dragover", (e) => {
      e.preventDefault();
      stageBox.classList.add("is-drop");
    });
    stageBox.addEventListener("dragleave", () => stageBox.classList.remove("is-drop"));
    stageBox.addEventListener("drop", (e) => {
      e.preventDefault();
      stageBox.classList.remove("is-drop");
      const f = e.dataTransfer?.files?.[0];
      if (f) useFile(f);
    });

    // "Adjust position" ↔ "Done": a new placement is drawn on the real piece again (the wait dialog, in the background).
    adjust.addEventListener("click", () => {
      if (!placing) {
        placing = true;
        adjust.textContent = this.t("adjustDone", "Done");
        void draw();
        return;
      }
      placing = false;
      adjust.textContent = this.t("adjust", "Adjust position");
      const sel = dialogSel();
      const want = this.wantedPhoi(sel);
      if (!want || want.stored.task.phoi?.key === want.key) {
        void draw();
        return;
      }
      const token = ++job;
      leaving = "placement";
      status.textContent = "";
      setBusy(true, phoiSteps[0], phoiSteps, "background");
      void this.askPhoi(sel)
        .then((key) => (key ? this.waitPhoi(want.stored.id, key) : null))
        .catch((e: unknown) => {
          if (token === job) status.textContent = e instanceof Error ? e.message : String(e);
        })
        .finally(() => {
          if (token !== job) return;
          setBusy(false);
          void draw();
        });
    });

    // ---- hand placement: drag = move, corner = resize, ↻ = rotate, two fingers = pinch, wheel = zoom
    type Grab =
      | { kind: "move"; start: { x: number; y: number }; t: CtTransform; frameRot: number; inner: { w: number; h: number } }
      | { kind: "scale"; center: { x: number; y: number }; d0: number; t: CtTransform }
      | { kind: "rotate"; center: { x: number; y: number }; a0: number; t: CtTransform };
    let grab: Grab | null = null;
    const touches = new Map<number, { x: number; y: number }>();
    let pinch: { d0: number; a0: number; t: CtTransform } | null = null;
    canvas.style.touchAction = "none";
    canvas.addEventListener("pointerdown", (e) => {
      const g = geom();
      if (!photoUrl || !g || showingPhoi) return;
      canvas.setPointerCapture(e.pointerId);
      const w = toMain(e);
      touches.set(e.pointerId, w);
      if (touches.size === 2) {
        const [a, b] = [...touches.values()];
        pinch = { d0: Math.hypot(b.x - a.x, b.y - a.y), a0: Math.atan2(b.y - a.y, b.x - a.x), t };
        grab = null;
        return;
      }
      const hit = 14 * screenPx();
      const rh = rotateHandle(g);
      if (Math.hypot(w.x - rh.x, w.y - rh.y) < hit) {
        grab = { kind: "rotate", center: g.center, a0: Math.atan2(w.y - g.center.y, w.x - g.center.x), t };
      } else if (corners(g).some((c) => Math.hypot(w.x - c.x, w.y - c.y) < hit)) {
        grab = { kind: "scale", center: g.center, d0: Math.max(1, Math.hypot(w.x - g.center.x, w.y - g.center.y)), t };
      } else {
        grab = { kind: "move", start: w, t, frameRot: g.frameRot, inner: g.inner };
      }
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!touches.has(e.pointerId)) {
        // Hover: which handle is under the pointer.
        const g = geom();
        if (!g || showingPhoi) return;
        const w = toMain(e);
        const hit = 14 * screenPx();
        const rh = rotateHandle(g);
        canvas.style.cursor = Math.hypot(w.x - rh.x, w.y - rh.y) < hit ? "grab" : corners(g).some((c) => Math.hypot(w.x - c.x, w.y - c.y) < hit) ? "nwse-resize" : "move";
        return;
      }
      const w = toMain(e);
      touches.set(e.pointerId, w);
      if (pinch && touches.size === 2) {
        const [a, b] = [...touches.values()];
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        t = { ...pinch.t, scale: Math.min(8, Math.max(0.1, (pinch.t.scale * d) / Math.max(1, pinch.d0))), rotation: pinch.t.rotation + ((ang - pinch.a0) * 180) / Math.PI };
      } else if (grab?.kind === "move") {
        const dx = w.x - grab.start.x;
        const dy = w.y - grab.start.y;
        const a = (-grab.frameRot * Math.PI) / 180;
        const lx = dx * Math.cos(a) - dy * Math.sin(a);
        const ly = dx * Math.sin(a) + dy * Math.cos(a);
        t = { ...grab.t, offsetX: grab.t.offsetX + lx / grab.inner.w, offsetY: grab.t.offsetY + ly / grab.inner.h };
      } else if (grab?.kind === "scale") {
        const d = Math.hypot(w.x - grab.center.x, w.y - grab.center.y);
        t = { ...grab.t, scale: Math.min(8, Math.max(0.1, (grab.t.scale * d) / grab.d0)) };
      } else if (grab?.kind === "rotate") {
        let rot = grab.t.rotation + ((Math.atan2(w.y - grab.center.y, w.x - grab.center.x) - grab.a0) * 180) / Math.PI;
        rot = ((((rot + 180) % 360) + 360) % 360) - 180;
        // Snap to upright.
        if (Math.abs(rot) < 3) rot = 0;
        t = { ...grab.t, rotation: Math.round(rot * 10) / 10 };
      } else return;
      void draw();
    });
    const release = (e: PointerEvent) => {
      touches.delete(e.pointerId);
      if (touches.size < 2) pinch = null;
      if (touches.size === 0) grab = null;
    };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);
    canvas.addEventListener(
      "wheel",
      (e) => {
        if (!photoUrl || showingPhoi) return;
        e.preventDefault();
        t = { ...t, scale: Math.min(8, Math.max(0.1, t.scale * Math.exp(-e.deltaY * 0.0015))) };
        void draw();
      },
      { passive: false },
    );

    const free = (kept: Array<string | null>) => {
      job++;
      for (const url of made) {
        if (kept.includes(url)) continue;
        URL.revokeObjectURL(url);
        this.localBlobs.delete(url);
      }
    };
    const close = () => {
      magic.hide();
      waitDlg.hide();
      waitDlg.remove();
      dialog.close();
      dialog.remove();
    };
    cancel.addEventListener("click", () => {
      free([]);
      close();
    });
    const applyNow = () => {
      if (!photoUrl) return;
      free([photoUrl, sourceUrl]);
      // A task's photo is public already; its upload too (kept for fulfilment).
      const tid = this.taskByPhoto.get(photoUrl);
      if (tid) sourceUrl = getTask(tid)?.task.sourceUrl ?? sourceUrl;
      this.change(r.id, { kind: "photo", url: photoUrl, transform: t, style, sourceUrl, optionId });
      close();
      // Start uploading now so Add to cart finds them done.
      for (const url of new Set([photoUrl, sourceUrl])) if (url) void this.uploadLocal(url).catch(() => undefined);
    };
    apply.addEventListener("click", applyNow);

    // "Keep browsing": the dialogs close, the task goes on; its photo goes in by itself when it is ready (a photo
    // already there with a new placement goes in now, its piece is drawn again in the background).
    const waitDlg = this.waitDialog(magic, {
      keep: () => {
        if (leaving === "placement" && photoUrl) {
          applyNow();
          return;
        }
        const id = taskOf.get(style);
        const pending = renders.get(style);
        if (id) this.autoApply(r, id, style, optionId);
        else if (pending) {
          // The editor preview has no server task: the redraw running in this page goes in by itself when it is done.
          const st = style;
          const src = sourceUrl;
          free([src]);
          close();
          void pending
            .then((url) => {
              if (!this.destroyed) this.change(r.id, { kind: "photo", url, transform: { ...IDENTITY_TRANSFORM }, style: st, sourceUrl: src, optionId });
            })
            .catch(() => undefined);
          return;
        }
        free([]);
        close();
      },
      cancel: () => {
        job++;
        setBusy(false);
      },
    });

    // A new name redraws the styles that write it (the others keep their picture).
    nameInput.addEventListener("change", () => {
      this.photoNames.set(r.id, nameInput.value);
      for (const id of cfg.styles) {
        if (!asksName(id) || !renders.has(id)) continue;
        renders.delete(id);
        swatches.get(id)?.querySelector(".ct-filter__dot")?.replaceChildren(emptyDot(id));
      }
      if (sourceUrl && asksName(style)) void show(style);
    });
    const controls: HTMLElement[] = [];
    if (cfg.styles.some(asksName)) controls.push(nameRow);
    if (cfg.styles.length > 1) controls.push(el("div", { class: "ct-dialog__style" }, [el("span", { class: "ct-dialog__style-label", text: cfg.styleLabel || this.t("filter", "Filter") }), styleRow]));
    controls.push(el("div", { class: "ct-dialog__tools" }, [pick, adjust, file, hint]));
    if (photoUrl) pick.textContent = this.t("changePhoto", "Change photo");
    dialog.append(
      el("div", { class: "ct-dialog__head" }, [el("strong", { text: cfg.label }), status]),
      stageBox,
      el("div", { class: "ct-dialog__controls" }, controls),
      el("div", { class: "ct-dialog__foot" }, [cancel, apply]),
    );
    // Esc closes the dialog. The file input's own "cancel" (picker dismissed)
    // bubbles up here too and must not.
    dialog.addEventListener("cancel", (e) => {
      if (e.target !== dialog) return;
      free([]);
      magic.hide();
      waitDlg.remove();
      dialog.remove();
    });
    markStyle();
    document.body.append(dialog);
    dialog.showModal();
    if (redraw && sourceUrl) {
      void show(style);
      return;
    }
    if (photoUrl) warmThumbs();
    void draw();
  }

  /** Public URL for a photo; blob: URLs are uploaded once and remembered. */
  private uploadLocal(url: string): Promise<string> {
    if (!url.startsWith("blob:") || this.previewMode) return Promise.resolve(url);
    const cached = this.uploads.get(url);
    if (cached) return cached;
    const blob = this.localBlobs.get(url);
    if (!blob) return Promise.reject(new Error("Photo is no longer available"));
    const p = shrinkImage(blob, PHOTO_MAX_PX).then((b) => this.upload(b, "photo"));
    this.uploads.set(url, p);
    p.catch((e: unknown) => {
      this.uploads.delete(url);
      console.warn("[ct] photo upload failed", e);
    });
    return p;
  }

  private async upload(blob: Blob, kind: "photo" | "preview" | "print"): Promise<string> {
    if (!this.uploadUrl) return URL.createObjectURL(blob);
    const body = new FormData();
    body.append("file", blob, `${kind}.${blob.type === "image/png" ? "png" : "jpg"}`);
    body.append("kind", kind);
    const res = await fetch(this.uploadUrl, { method: "POST", body, mode: "cors" });
    const json = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
    if (!res.ok || !json.url) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json.url;
  }

  // ------------------------------------------------------------- add to cart
  private submitting = false;

  /**
   * Capture-phase submit: validate, upload photos + a flattened preview, write
   * line-item properties, then re-submit so the theme's own cart handling
   * (AJAX drawer or plain POST) runs with them.
   */
  private async onSubmit(e: SubmitEvent): Promise<void> {
    if (this.form.dataset.ctReady === "1") {
      delete this.form.dataset.ctReady;
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    if (this.submitting) return;
    const problem = this.validate();
    if (problem) {
      this.errorBox.textContent = problem;
      this.errorBox.hidden = false;
      this.errorBox.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const button = (e.submitter as HTMLButtonElement | null) ?? this.form.querySelector<HTMLButtonElement>('[type="submit"]');
    this.submitting = true;
    button?.classList.add("ct-loading-btn");
    if (button) button.disabled = true;
    try {
      const designs = await this.finalDesigns();
      // One flattened preview per design (the order's artwork); the order still carries every choice without them.
      const previews: string[] = [];
      for (const selection of designs) {
        let url = "";
        try {
          const c = await this.product(selection, PREVIEW_MAX_PX);
          url = await this.upload(await canvasToBlob(c, "image/png"), "preview");
        } catch (err) {
          console.warn("[ct] preview upload failed", err);
        }
        previews.push(url);
      }
      // The print file of each design, full size — what goes to the printer as it is.
      const prints: string[] = [];
      for (const selection of designs) {
        let url = "";
        try {
          url = await this.upload(await canvasToBlob(await this.printFile(selection), "image/png"), "print");
        } catch (err) {
          console.warn("[ct] print file upload failed", err);
        }
        prints.push(url);
      }
      const properties = this.cartProperties(designs, previews, prints);
      if (this.options.onPreviewCart) {
        this.options.onPreviewCart({ properties, previewUrl: previews[0] ?? "", previews });
        return;
      }
      this.writeProperties(properties);
      this.form.dataset.ctReady = "1";
      if (button) button.disabled = false;
      this.form.requestSubmit(button ?? undefined);
    } catch (err) {
      this.errorBox.textContent = err instanceof Error ? err.message : String(err);
      this.errorBox.hidden = false;
      if (button) button.disabled = false;
    } finally {
      this.submitting = false;
      button?.classList.remove("ct-loading-btn");
      if (button && this.previewMode) button.disabled = false;
    }
  }

  /** The designs the cart line holds (the pack's count). */
  private ordered(): CtSelection[] {
    return this.designs.slice(0, this.count);
  }

  /** First missing field over every design; that design is opened so the customer sees it. */
  private validate(): string | null {
    for (let i = 0; i < this.count; i++) {
      const problem = this.validateDesign(this.designs[i] ?? {});
      if (!problem) continue;
      if (i !== this.active) this.goTo(i);
      return this.count > 1 ? `${this.itemLabel(i)} — ${problem}` : problem;
    }
    return null;
  }

  private validateDesign(selection: CtSelection): string | null {
    for (const r of this.shownRegions(selection)) {
      const sel = selection[r.id];
      if (r.kind === "photo" && r.config.photo.required && !(sel?.kind === "photo" && sel.url)) {
        return `${this.t("required", "Please complete")}: ${r.config.photo.label}`;
      }
      const mode = r.kind === "text" ? textMode(r) : null;
      if ((mode === "input" || mode === "list") && !(sel?.kind === "text" && sel.text.trim())) {
        return `${this.t("required", "Please complete")}: ${r.config.text.label}`;
      }
      if (mode === "input" && r.config.text.format === "date" && sel?.kind === "text" && !isValidDate(sel.text)) {
        return `${this.t("invalidDate", "Please enter a valid date (dd/mm/yyyy)")}: ${r.config.text.label}`;
      }
      if (r.kind === "image" && !this.isFixedLayer(r) && !r.config.image.allowNone && regionGroups(r, this.tpl.items, this.tpl.assets).length > 0) {
        if (!(sel?.kind === "image" && sel.assetId)) return `${this.t("required", "Please complete")}: ${r.config.image.label}`;
      }
    }
    return null;
  }

  /** Every ordered design with its customer photos (render and original) replaced by their uploaded URLs. */
  private async finalDesigns(): Promise<CtSelection[]> {
    const out: CtSelection[] = [];
    for (const [i, design] of this.ordered().entries()) {
      const sel: CtSelection = { ...design };
      for (const [id, v] of Object.entries(sel)) {
        if (v.kind !== "photo" || !v.url) continue;
        try {
          const url = await this.uploadLocal(v.url);
          const sourceUrl = v.sourceUrl ? await this.uploadLocal(v.sourceUrl) : null;
          sel[id] = { ...v, url, sourceUrl };
        } catch {
          throw new Error(this.t("uploadFailed", "Photo upload failed — please try again."));
        }
      }
      this.designs[i] = sel;
      out.push(sel);
    }
    return out;
  }

  private writeProperties(properties: Array<[string, string]>): void {
    for (const old of Array.from(this.form.querySelectorAll("[data-ct-prop]"))) old.remove();
    for (const [key, value] of properties) {
      this.form.append(el("input", { type: "hidden", name: `properties[${key}]`, value, "data-ct-prop": true }));
    }
  }

  /**
   * The line-item properties Add to cart posts, in form order. A pack prefixes each design's choices with its
   * name ("Ornament 2 · Enter name") and carries one preview per design (_ct_preview, _ct_preview_2…) and every
   * selection (_ct_selections, a JSON array); a single design keeps the one-design form (_ct_selection).
   */
  private cartProperties(designs: CtSelection[], previews: string[], prints: string[] = []): Array<[string, string]> {
    const tpl = this.tpl;
    const byId = new Map(tpl.assets.map((a) => [a.id, a]));
    const used = new Set<string>();
    const out: Array<[string, string]> = [];
    const add = (name: string, value: string) => {
      let key = name.trim() || "Option";
      for (let n = 2; used.has(key); n++) key = `${name} (${n})`;
      used.add(key);
      out.push([key, value]);
    };

    const many = designs.length > 1;
    for (const [i, selection] of designs.entries()) {
      const prefix = many ? `${this.itemLabel(i)} · ` : "";
      // Hidden properties start with "_" — the prefix goes after it.
      const named = (name: string, value: string) => (name.startsWith("_") ? add(`_${prefix}${name.slice(1)}`, value) : add(`${prefix}${name}`, value));
      // This design's answers so far: an option name does not repeat one ("Hair: Short Curly", the colour has its own line).
      const answers: string[] = [];
      const option = (label: string, name: string) => {
        const v = customerOptionName(name, label, answers);
        answers.push(v);
        named(label, v);
      };
      if (tpl.config.main.enabled) {
        const m = byId.get(selectedMainId(selection, tpl.assets, tpl.mainAssetId));
        if (m) named(tpl.config.main.label, m.name);
        const pic = byId.get(selectedMainImageId(selection, tpl.assets, tpl.mainAssetId));
        if (m && pic && pic.id !== m.id) named(m.name, pic.name);
      }
      for (const r of this.shownRegions(selection)) {
        const sel = selection[r.id];
        if (this.isFixedLayer(r)) continue;
        if (r.kind === "image" && sel?.kind === "image") {
          const groups = regionGroups(r, tpl.items, tpl.assets);
          const at = locateOption(groups, sel.assetId);
          if (at.group < 0) {
            if (r.config.image.allowNone) named(r.config.image.label, this.t("none", "None"));
            continue;
          }
          if (groups.length > 1) option(r.config.image.groupLabel, groups[at.group].name);
          option(r.config.image.label || r.name, groups[at.group].options[at.option].name);
        } else if (r.kind === "text") {
          const mode = textMode(r);
          const tsel: CtTextSelection = sel?.kind === "text" ? sel : { kind: "text", text: "" };
          // A fixed text is the design's own; an "options" text records the option picked (its name).
          if (mode === "options") {
            const picked = r.config.options.list.find((x) => x.id === tsel.optionId);
            named(r.config.text.label || r.name, picked ? picked.name || zoneText(r, tsel) : r.config.options.baseName || zoneText(r, tsel));
          } else if (mode !== "fixed") named(r.config.text.label, tsel.text);
          if (mode !== "options") this.zoneOptionProperty(r, tsel, named);
        } else if (r.kind === "photo" && sel?.kind === "photo" && sel.url) {
          const cfg = r.config.photo;
          named(cfg.label, sel.url);
          if (cfg.styles.length > 1 || cfg.defaultStyle !== "original") named(cfg.styleLabel, styleLabel(sel.style, this.tpl.aiStyles));
          this.zoneOptionProperty(r, sel, named);
          // Fulfilment may want to re-render from the untouched upload.
          if (sel.sourceUrl && sel.sourceUrl !== sel.url) named(`_${cfg.label} (original)`, sel.sourceUrl);
        }
      }
    }
    // Underscore properties are hidden from the customer in cart/checkout.
    previews.forEach((url, i) => url && add(i === 0 ? "_ct_preview" : `_ct_preview_${i + 1}`, url));
    prints.forEach((url, i) => url && add(i === 0 ? "_ct_print" : `_ct_print_${i + 1}`, url));
    add("_ct_template", `${tpl.productId}@v${tpl.version}`);
    if (many) {
      add("_ct_designs", String(designs.length));
      add("_ct_selections", JSON.stringify(designs));
    } else {
      add("_ct_selection", JSON.stringify(designs[0] ?? {}));
    }
    return out;
  }

  /** "Choose color: Gold" for a zone with sub-options. */
  private zoneOptionProperty(r: CtRegion, sel: CtTextSelection | CtPhotoSelection, add: (name: string, value: string) => void): void {
    const o = r.config.options;
    if (!o.list.length) return;
    const picked = o.list.find((x) => x.id === sel.optionId);
    add(o.label, picked ? picked.name || this.t("option", "Option") : o.baseName || this.t("default", "Default"));
  }
}
