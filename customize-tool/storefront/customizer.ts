/**
 * The storefront customizer for `shopify/sections/main-product.liquid` — no
 * side effects on import. Two hosts mount it:
 *
 *   storefront/index.ts   the Shopify theme (bundled to shopify/assets/ct-customizer.js),
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
 *   script[data-ct-variants]     { variantId: { price, compare, available, media } }
 *   data-ct-template-url / data-ct-upload-url on the root (absent = plain product page)
 *
 * A gallery without product media starts on the live canvas.
 */

import { CT_MAIN_KEY } from "../types";
import type { CtOptionDisplay, CtPhotoSelection, CtPhotoStyleRef, CtRegion, CtRenderAsset, CtSelection, CtTemplate, CtTransform } from "../types";
import { ctGoogleFontsHref } from "../config";
import { canvasToBlob, compositeBleed, drawComposite, loadImage, renderComposite } from "../lib/compositor";
import { isHidden, layoutFor, onVersion } from "../lib/layout";
import { drawOnScene } from "../lib/scene";
import {
  defaultRegionSelection,
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
  regionGroups,
  selectedMainId,
  selectedMainImageId,
} from "../lib/design";
import { IDENTITY_TRANSFORM, shapeBounds } from "../lib/geometry";
import { processPhoto, shrinkImage } from "../lib/photo-process";
import { styleEngine, styleLabel } from "../lib/photo-styles";

interface VariantInfo {
  price: string;
  compare: string | null;
  available: boolean;
  media: string | null;
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
  /** Flattened render of the design (object URL in preview mode). */
  previewUrl: string;
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
  const matrix = readJson<Array<{ id: number; options: string[] }>>(root, "script[data-ct-variant-options]") ?? [];
  const idInput = form.querySelector<HTMLInputElement>('input[name="id"]');
  const selects = Array.from(root.querySelectorAll<HTMLSelectElement | HTMLInputElement>("[data-ct-option-index]"));
  const price = root.querySelector<HTMLElement>("[data-ct-price]");
  const compare = root.querySelector<HTMLElement>("[data-ct-compare]");
  const submit = form.querySelector<HTMLButtonElement>('[type="submit"]');
  const sync = () => {
    const chosen: string[] = [];
    for (const s of selects) {
      if (s instanceof HTMLInputElement && s.type === "radio" && !s.checked) continue;
      chosen[Number(s.dataset.ctOptionIndex)] = s.value;
    }
    const match = matrix.find((v) => v.options.every((o, i) => chosen[i] === undefined || chosen[i] === o));
    if (!match || !idInput) return;
    idInput.value = String(match.id);
    const info = variants[String(match.id)];
    if (!info) return;
    if (price) price.textContent = info.price;
    if (compare) {
      compare.textContent = info.compare ?? "";
      compare.hidden = !info.compare;
    }
    if (submit) {
      submit.disabled = !info.available;
      const label = submit.querySelector("[data-ct-submit-label]");
      if (label) label.textContent = info.available ? (submit.dataset.labelAdd ?? "Add to cart") : (submit.dataset.labelSoldout ?? "Sold out");
    }
    if (info.media) showMedia(info.media);
    const url = new URL(window.location.href);
    url.searchParams.set("variant", String(match.id));
    window.history.replaceState(null, "", url.toString());
  };
  for (const s of selects) s.addEventListener("change", sync);
}

// ---------------------------------------------------------------------------
// Customizer
// ---------------------------------------------------------------------------

export class Customizer {
  private tpl!: CtTemplate;
  private main!: CtRenderAsset;
  private selection: CtSelection = {};
  private regions: CtRegion[] = [];
  private raf = 0;
  private renderToken = 0;
  /** Local object URL -> its bytes, for photos (originals and renders) not uploaded yet. */
  private localBlobs = new Map<string, Blob>();
  /** Local object URL -> public URL, one upload per blob however often it is asked for. */
  private uploads = new Map<string, Promise<string>>();

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
    this.selection = defaultSelection(this.regions, tpl.items, tpl.assets, tpl.mainAssetId);
    this.root.classList.add("ct-is-custom");

    this.renderOptions();
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
  }

  /**
   * Swap in a new template (the editor preview, on every design change) and
   * keep whatever the customer already chose that is still valid, so a new
   * zone or option shows up at once without resetting the form.
   */
  setTemplate(tpl: CtTemplate): void {
    if (this.destroyed || !this.tpl) return;
    if (!this.applyTemplate(tpl)) return;
    const next = defaultSelection(this.regions, tpl.items, tpl.assets, tpl.mainAssetId);
    const main = this.selection[CT_MAIN_KEY];
    if (main?.kind === "main" && main.assetId && tpl.assets.some((a) => a.id === main.assetId && a.role === "main")) next[CT_MAIN_KEY] = main;
    for (const r of this.regions) {
      const cur = this.selection[r.id];
      if (!isSelectionValid(r, cur, tpl.items, tpl.assets)) continue;
      // Preset texts changed: a text no longer offered falls back to the first preset.
      const choices = r.config.text.choices.filter(Boolean);
      if (r.kind === "text" && cur?.kind === "text" && choices.length > 0 && !choices.includes(cur.text)) continue;
      next[r.id] = cur ?? defaultRegionSelection(r, tpl.items, tpl.assets);
    }
    this.selection = next;
    this.renderOptions();
    this.scheduleRender();
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
    // The design on the product's background (Thiết kế → Nền), when it has one.
    const b = compositeBleed({ main: this.main, assets: this.tpl.assets, selection: this.selection, layouts: this.tpl.config.layouts });
    const bleed = { x: b.x / this.main.width, y: b.y / this.main.height };
    const off = await this.product(this.selection, side)
      .then((c) => drawOnScene(this.tpl.config.scene, c, side, bleed))
      .catch(() => null);
    if (!off || token !== this.renderToken) return;
    canvas.width = off.width;
    canvas.height = off.height;
    canvas.getContext("2d")?.drawImage(off, 0, 0);
  }

  /** Flat design (photo editor, exports). */
  private compose(selection: CtSelection, scale: number): Promise<HTMLCanvasElement> {
    return renderComposite({ main: this.main, assets: this.tpl.assets, regions: this.regions, items: this.tpl.items, selection, scale, layouts: this.tpl.config.layouts });
  }

  /**
   * The product as the customer sees it (material renditions are already swapped in by the template), long side
   * `maxSide` — grown by the material version's padding, so its plate / cord are not cut off.
   */
  private product(selection: CtSelection, maxSide: number): Promise<HTMLCanvasElement> {
    const input = { main: this.main, assets: this.tpl.assets, regions: this.regions, items: this.tpl.items, selection, layouts: this.tpl.config.layouts };
    const b = compositeBleed(input);
    const scale = Math.min(1, maxSide / Math.max(this.main.width + 2 * b.x, this.main.height + 2 * b.y));
    return renderComposite({ ...input, scale, bleed: true });
  }

  /** Zones the chosen main version uses: its own layers (older templates: a layout may hide some). */
  private shownRegions(selection: CtSelection = this.selection): CtRegion[] {
    const mainId = selectedMainId(selection, this.tpl.assets, this.tpl.mainAssetId);
    const layout = layoutFor(this.tpl.config.layouts, mainId);
    return formOrder(this.regions).filter((r) => onVersion(r, mainId) && !isHidden(layout, r.id));
  }

  private change(key: string, value: CtSelection[string]): void {
    this.selection = { ...this.selection, [key]: value };
    this.errorBox.hidden = true;
    this.renderOptions();
    this.showStage();
  }

  // ------------------------------------------------------------- options
  private renderOptions(): void {
    const tpl = this.tpl;
    const wrap = el("div", { class: "ct-personalize" });
    wrap.append(el("div", { class: "ct-personalize__head", text: this.t("heading", "Personalized") }));

    const mains = tpl.config.main.enabled ? mainVersions(tpl.assets, tpl.mainAssetId) : [];
    if (mains.length > 1) {
      const current = selectedMainId(this.selection, tpl.assets, tpl.mainAssetId);
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
      // The chosen version's sub-options ("Thêm option"): the version itself first, then its other pictures.
      const version = mains.find((m) => m.id === current);
      const subs = version ? mainSubOptions(tpl.assets, tpl.config.main, version.id) : [];
      if (version && subs.length) {
        const shown = selectedMainImageId(this.selection, tpl.assets, tpl.mainAssetId);
        const list = [version, ...subs];
        wrap.append(
          this.field(
            version.name,
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
    }

    for (const r of this.shownRegions()) {
      const sel = this.selection[r.id];
      if (r.kind === "image") {
        const groups = regionGroups(r, tpl.items, tpl.assets);
        if (groups.length === 0) continue;
        const current = sel?.kind === "image" ? sel.assetId : null;
        const at = locateOption(groups, current);
        const group = groups[Math.max(0, at.group)];
        if (groups.length > 1) {
          wrap.append(
            this.field(
              r.config.image.groupLabel,
              this.picker(
                r.config.image.groupDisplay,
                groups.map((g) => ({ id: g.item.id, label: g.name, image: g.options[0].url, swatch: g.options[0].meta.swatch })),
                group.item.id,
                false,
                (id) => {
                  const gi = groups.findIndex((g) => g.item.id === id);
                  this.change(r.id, { kind: "image", assetId: optionInGroup(groups, gi, current) });
                },
              ),
              true,
              group.name,
            ),
          );
        }
        wrap.append(
          this.field(
            r.config.image.label || r.name,
            this.picker(
              r.config.image.display,
              group.options.map((o) => ({ id: o.id, label: o.name, image: o.url, swatch: o.meta.swatch })),
              current,
              r.config.image.allowNone,
              (id) => this.change(r.id, { kind: "image", assetId: id }),
            ),
            !r.config.image.allowNone,
            current ? group.options.find((o) => o.id === current)?.name : undefined,
          ),
        );
      } else if (r.kind === "text") {
        wrap.append(this.textField(r, sel?.kind === "text" ? sel.text : ""));
      } else {
        wrap.append(this.photoField(r, sel?.kind === "photo" ? sel : null));
      }
    }
    wrap.append(this.errorBox);
    this.optionsHost.replaceChildren(wrap);
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
    for (const o of options) {
      if (display === "button") add(o.id, el("span", { class: "ct-choice__text", text: o.label }), o.label);
      else if (display === "swatch" && o.swatch) add(o.id, el("span", { class: "ct-choice__swatch", style: `background:${o.swatch}` }), o.label);
      else add(o.id, el("img", { src: o.image ?? "", alt: o.label, loading: "lazy" }), o.label);
    }
    return list;
  }

  private textField(r: CtRegion, text: string): HTMLElement {
    const cfg = r.config.text;
    const choices = cfg.choices.filter(Boolean);
    if (choices.length > 0) {
      return this.field(
        cfg.label,
        this.picker("dropdown", choices.map((c) => ({ id: c, label: c })), text || null, false, (v) => v !== null && this.change(r.id, { kind: "text", text: v })),
        true,
      );
    }
    const counter = el("span", { class: "ct-counter", text: `${text.length}/${cfg.maxChars}` });
    const input = el("input", { class: "ct-input", type: "text", value: text, maxlength: String(cfg.maxChars), placeholder: cfg.placeholder });
    input.addEventListener("input", () => {
      // Not via change(): re-rendering the form would steal focus mid-typing.
      this.selection = { ...this.selection, [r.id]: { kind: "text", text: input.value } };
      counter.textContent = `${input.value.length}/${cfg.maxChars}`;
      this.errorBox.hidden = true;
      this.showStage();
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
    return this.field(cfg.label, body, cfg.required, styleName);
  }

  // ------------------------------------------------------------- photo dialog
  /**
   * Upload → pick a style → position (drag, zoom, rotate) on the real product
   * render → Apply. Styled / cut-out renders are made once per style and
   * cached for the dialog's lifetime, so flipping styles back is instant.
   * Files upload when the customer applies, so Add to cart does not wait on them.
   */
  private openPhotoDialog(r: CtRegion, current: CtPhotoSelection | null): void {
    const cfg = r.config.photo;
    const dialog = el("dialog", { class: "ct-dialog", "data-ct-owner": this.root.id || undefined });
    // The dialog lives on <body>, outside the section that sets the accent.
    dialog.style.setProperty("--ct-accent", getComputedStyle(this.root).getPropertyValue("--ct-accent"));
    const canvas = el("canvas", { class: "ct-dialog__canvas" });
    const empty = el("div", { class: "ct-dialog__empty", text: this.t("dropPhoto", "Choose a photo to start") });
    const busyText = el("span");
    const busy = el("div", { class: "ct-dialog__busy", hidden: true }, [el("span", { class: "ct-spinner" }), busyText]);
    const file = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp", hidden: true });
    const pick = el("button", { type: "button", class: "ct-btn ct-btn--ghost", text: this.t("choosePhoto", "Choose photo") });
    const transform = current?.transform ?? { ...IDENTITY_TRANSFORM };
    const zoom = el("input", { type: "range", min: "20", max: "400", value: String(Math.round(transform.scale * 100)) });
    const rotate = el("input", { type: "range", min: "-180", max: "180", value: String(Math.round(transform.rotation)) });
    const apply = el("button", { type: "button", class: "ct-btn ct-btn--primary", text: this.t("apply", "Apply") });
    const cancel = el("button", { type: "button", class: "ct-btn ct-btn--ghost", text: this.t("cancel", "Cancel") });
    const status = el("span", { class: "ct-dialog__status" });

    let style: CtPhotoStyleRef = current?.style && cfg.styles.includes(current.style) ? current.style : cfg.defaultStyle;
    let sourceUrl = current?.sourceUrl ?? current?.url ?? null;
    let photoUrl = current?.url ?? null;
    let t: CtTransform = { ...transform };
    let source: Blob | null = sourceUrl ? (this.localBlobs.get(sourceUrl) ?? null) : null;
    let renders = new Map<CtPhotoStyleRef, Promise<string>>();
    if (photoUrl && current?.style === style) renders.set(style, Promise.resolve(photoUrl));
    /** Blob URLs made by this dialog; the ones not applied are freed on close. */
    const made = new Set<string>();
    let job = 0;

    const keep = (blob: Blob): string => {
      const url = URL.createObjectURL(blob);
      this.localBlobs.set(url, blob);
      made.add(url);
      return url;
    };

    const styleSelect = el("select", { class: "ct-select" });
    for (const id of cfg.styles) styleSelect.append(el("option", { value: id, text: styleLabel(id, this.tpl.aiStyles), selected: id === style }));

    const draw = async () => {
      empty.hidden = Boolean(photoUrl);
      const scale = Math.min(1, 900 / this.main.width);
      const sel: CtSelection = { ...this.selection, [r.id]: { kind: "photo", url: photoUrl, transform: t, style, sourceUrl } };
      const c = await this.compose(sel, scale).catch(() => null);
      if (!c) return;
      canvas.width = c.width;
      canvas.height = c.height;
      canvas.getContext("2d")?.drawImage(c, 0, 0);
    };

    const setBusy = (on: boolean, text = "") => {
      busy.hidden = !on;
      busyText.textContent = text;
      apply.disabled = on;
      empty.hidden = on || Boolean(photoUrl);
    };

    const render = (next: CtPhotoStyleRef): Promise<string> => {
      const cached = renders.get(next);
      if (cached) return cached;
      const src = sourceUrl;
      if (!src) return Promise.reject(new Error("No photo"));
      const engine = styleEngine(next);
      const p =
        engine === "none" && !cfg.cutout
          ? Promise.resolve(src) // untouched photo: nothing to compute
          : engine === "local" && cfg.cutout
            ? (async () => {
                // Local filters run on the cut-out "Real photo", so the server is asked only once.
                const baseUrl = await render("original");
                const base: Blob = this.localBlobs.get(baseUrl) ?? (await fetch(baseUrl).then((res) => res.blob()));
                return keep(await processPhoto({ source: base, style: next, cutout: false, endpoint: this.photoUrl }));
              })()
            : (async () => {
                const blob: Blob = source ?? (await fetch(src).then((res) => res.blob()));
                source = blob;
                return keep(await processPhoto({ source: blob, style: next, cutout: cfg.cutout, fadeCrop: cfg.fadeCrop, endpoint: this.photoUrl, fields: { region: r.id } }));
              })();
      renders.set(next, p);
      p.catch(() => renders.delete(next));
      return p;
    };

    const show = async (next: CtPhotoStyleRef) => {
      if (!sourceUrl) return;
      const token = ++job;
      status.textContent = "";
      // Anything not rendered yet shows the spinner; the untouched upload is never drawn in the frame.
      if (!renders.has(next)) {
        const cutoutOnly = cfg.cutout && (next === "original" || (styleEngine(next) === "local" && !renders.has("original")));
        setBusy(true, cutoutOnly ? this.t("removingBg", "Removing background…") : `${this.t("creating", "Creating")} ${styleLabel(next, this.tpl.aiStyles)}…`);
      }
      try {
        const url = await render(next);
        if (token !== job) return;
        photoUrl = url;
        style = next;
        await draw();
      } catch (e) {
        if (token !== job) return;
        styleSelect.value = style;
        status.textContent = e instanceof Error ? e.message : String(e);
      } finally {
        if (token === job) setBusy(false);
      }
    };

    styleSelect.addEventListener("change", () => void show(styleSelect.value as CtPhotoStyleRef));
    pick.addEventListener("click", () => file.click());
    file.addEventListener("change", () => {
      const f = file.files?.[0];
      if (!f) return;
      source = f;
      sourceUrl = keep(f);
      renders = new Map();
      t = { ...IDENTITY_TRANSFORM };
      zoom.value = "100";
      rotate.value = "0";
      // The frame stays empty behind the spinner until the processed photo (cut-out + style) is ready.
      photoUrl = null;
      void draw();
      void show(style);
    });
    zoom.addEventListener("input", () => {
      t = { ...t, scale: Number(zoom.value) / 100 };
      void draw();
    });
    rotate.addEventListener("input", () => {
      t = { ...t, rotation: Number(rotate.value) };
      void draw();
    });

    // Drag moves the photo inside its zone; offsets are fractions of the zone box.
    // The zone as the chosen main version lays it out.
    const layout = layoutFor(this.tpl.config.layouts, selectedMainId(this.selection, this.tpl.assets, this.tpl.mainAssetId));
    const bounds = shapeBounds(layout?.regions[r.id]?.shape ?? r.shape);
    let drag: { x: number; y: number; t: CtTransform } | null = null;
    canvas.addEventListener("pointerdown", (e) => {
      if (!photoUrl) return;
      canvas.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, t };
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const k = this.main.width / Math.max(1, canvas.getBoundingClientRect().width);
      t = {
        ...drag.t,
        offsetX: drag.t.offsetX + ((e.clientX - drag.x) * k) / Math.max(1, bounds.w),
        offsetY: drag.t.offsetY + ((e.clientY - drag.y) * k) / Math.max(1, bounds.h),
      };
      void draw();
    });
    const endDrag = () => (drag = null);
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);

    const release = (kept: Array<string | null>) => {
      job++;
      for (const url of made) {
        if (kept.includes(url)) continue;
        URL.revokeObjectURL(url);
        this.localBlobs.delete(url);
      }
    };
    const close = () => {
      dialog.close();
      dialog.remove();
    };
    cancel.addEventListener("click", () => {
      release([]);
      close();
    });
    apply.addEventListener("click", () => {
      if (!photoUrl) return;
      release([photoUrl, sourceUrl]);
      this.change(r.id, { kind: "photo", url: photoUrl, transform: t, style, sourceUrl });
      close();
      // Start uploading now so Add to cart finds them done.
      for (const url of new Set([photoUrl, sourceUrl])) if (url) void this.uploadLocal(url).catch(() => undefined);
    });

    const controls: HTMLElement[] = [];
    if (cfg.styles.length > 1) {
      controls.push(el("label", { class: "ct-dialog__style" }, [el("span", { text: cfg.styleLabel }), el("div", { class: "ct-select-wrap" }, [styleSelect])]));
    }
    controls.push(
      pick,
      file,
      el("label", { class: "ct-range" }, [el("span", { text: this.t("zoom", "Zoom") }), zoom]),
      el("label", { class: "ct-range" }, [el("span", { text: this.t("rotate", "Rotate") }), rotate]),
    );
    dialog.append(
      el("div", { class: "ct-dialog__head" }, [el("strong", { text: cfg.label }), status]),
      el("div", { class: "ct-dialog__stage" }, [canvas, empty, busy]),
      el("div", { class: "ct-dialog__controls" }, controls),
      el("div", { class: "ct-dialog__foot" }, [cancel, apply]),
    );
    // Esc closes the dialog. The file input's own "cancel" (picker dismissed)
    // bubbles up here too and must not.
    dialog.addEventListener("cancel", (e) => {
      if (e.target !== dialog) return;
      release([]);
      dialog.remove();
    });
    document.body.append(dialog);
    dialog.showModal();
    if (!photoUrl) file.click();
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

  private async upload(blob: Blob, kind: "photo" | "preview"): Promise<string> {
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
      const selection = await this.finalSelection();
      let previewUrl = "";
      try {
        const c = await this.product(selection, PREVIEW_MAX_PX);
        previewUrl = await this.upload(await canvasToBlob(c, "image/png"), "preview");
      } catch (err) {
        // The order still carries every choice; the preview is a convenience.
        console.warn("[ct] preview upload failed", err);
      }
      if (this.options.onPreviewCart) {
        this.options.onPreviewCart({ properties: this.cartProperties(selection, previewUrl), previewUrl });
        return;
      }
      this.writeProperties(selection, previewUrl);
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

  private validate(): string | null {
    for (const r of this.shownRegions()) {
      const sel = this.selection[r.id];
      if (r.kind === "photo" && r.config.photo.required && !(sel?.kind === "photo" && sel.url)) {
        return `${this.t("required", "Please complete")}: ${r.config.photo.label}`;
      }
      if (r.kind === "text" && !(sel?.kind === "text" && sel.text.trim())) {
        return `${this.t("required", "Please complete")}: ${r.config.text.label}`;
      }
      if (r.kind === "image" && !r.config.image.allowNone && regionGroups(r, this.tpl.items, this.tpl.assets).length > 0) {
        if (!(sel?.kind === "image" && sel.assetId)) return `${this.t("required", "Please complete")}: ${r.config.image.label}`;
      }
    }
    return null;
  }

  /** Selection with every customer photo (render and original) replaced by its uploaded URL. */
  private async finalSelection(): Promise<CtSelection> {
    const out: CtSelection = { ...this.selection };
    for (const [id, sel] of Object.entries(out)) {
      if (sel.kind !== "photo" || !sel.url) continue;
      try {
        const url = await this.uploadLocal(sel.url);
        const sourceUrl = sel.sourceUrl ? await this.uploadLocal(sel.sourceUrl) : null;
        out[id] = { ...sel, url, sourceUrl };
      } catch {
        throw new Error(this.t("uploadFailed", "Photo upload failed — please try again."));
      }
    }
    this.selection = out;
    return out;
  }

  private writeProperties(selection: CtSelection, previewUrl: string): void {
    for (const old of Array.from(this.form.querySelectorAll("[data-ct-prop]"))) old.remove();
    for (const [key, value] of this.cartProperties(selection, previewUrl)) {
      this.form.append(el("input", { type: "hidden", name: `properties[${key}]`, value, "data-ct-prop": true }));
    }
  }

  /** The line-item properties Add to cart posts, in form order. */
  private cartProperties(selection: CtSelection, previewUrl: string): Array<[string, string]> {
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

    if (tpl.config.main.enabled) {
      const m = byId.get(selectedMainId(selection, tpl.assets, tpl.mainAssetId));
      if (m) add(tpl.config.main.label, m.name);
      const pic = byId.get(selectedMainImageId(selection, tpl.assets, tpl.mainAssetId));
      if (m && pic && pic.id !== m.id) add(m.name, pic.name);
    }
    for (const r of this.shownRegions(selection)) {
      const sel = selection[r.id];
      if (r.kind === "image" && sel?.kind === "image") {
        const groups = regionGroups(r, tpl.items, tpl.assets);
        const at = locateOption(groups, sel.assetId);
        if (at.group < 0) {
          if (r.config.image.allowNone) add(r.config.image.label, this.t("none", "None"));
          continue;
        }
        if (groups.length > 1) add(r.config.image.groupLabel, groups[at.group].name);
        add(r.config.image.label || r.name, groups[at.group].options[at.option].name);
      } else if (r.kind === "text" && sel?.kind === "text") {
        add(r.config.text.label, sel.text);
      } else if (r.kind === "photo" && sel?.kind === "photo" && sel.url) {
        const cfg = r.config.photo;
        add(cfg.label, sel.url);
        if (cfg.styles.length > 1 || cfg.defaultStyle !== "original") add(cfg.styleLabel, styleLabel(sel.style, this.tpl.aiStyles));
        // Fulfilment may want to re-render from the untouched upload.
        if (sel.sourceUrl && sel.sourceUrl !== sel.url) add(`_${cfg.label} (original)`, sel.sourceUrl);
      }
    }
    // Underscore properties are hidden from the customer in cart/checkout.
    if (previewUrl) add("_ct_preview", previewUrl);
    add("_ct_template", `${tpl.productId}@v${tpl.version}`);
    add("_ct_selection", JSON.stringify(selection));
    return out;
  }
}
