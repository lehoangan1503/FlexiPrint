/**
 * The product page around the customizer, for the theme section only (storefront/index.ts) — not the
 * editor preview: quantity − / + buttons, the sale countdown + delivery estimate, the sticky Add to cart
 * bar, and the section's own cart drawer (AJAX /cart/add.js, then the drawer slides in — no page change).
 *
 * Everything lives in the section's markup (sections/flexi2-product.liquid), nothing is read from the
 * theme's own JS: the section works the same on any theme, and the theme's code is never touched.
 */

import { formatMoney } from "./customizer";

// ---------------------------------------------------------------------------
// Shopify AJAX cart (the parts used here)
// ---------------------------------------------------------------------------

interface ShopifyCartItem {
  key: string;
  quantity: number;
  title: string;
  product_title: string;
  variant_title: string | null;
  url: string;
  image: string | null;
  final_line_price: number;
  original_line_price: number;
  properties: Record<string, string> | null;
}

interface ShopifyCart {
  item_count: number;
  total_price: number;
  items: ShopifyCartItem[];
}

interface ShopifyAddResponse {
  sections?: Record<string, string | null>;
}

interface ShopifyError {
  description?: string;
  message?: string;
}

const HEADER_BUBBLE = "cart-icon-bubble";

async function errorText(res: Response, fallback: string): Promise<string> {
  try {
    const j = (await res.json()) as ShopifyError;
    return j.description || j.message || fallback;
  } catch {
    return fallback;
  }
}

/** The theme header's cart count (Dawn: #cart-icon-bubble, a section of its own) from a sections response. */
function updateHeaderBubble(sections: Record<string, string | null> | undefined): void {
  const html = sections?.[HEADER_BUBBLE];
  const target = document.getElementById(HEADER_BUBBLE);
  if (!html || !target) return;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const fresh = doc.querySelector(".shopify-section") ?? doc.body;
  target.innerHTML = fresh.innerHTML;
}

// ---------------------------------------------------------------------------
// Quantity
// ---------------------------------------------------------------------------

export function initQuantity(root: HTMLElement): void {
  for (const box of Array.from(root.querySelectorAll<HTMLElement>("[data-ct-qty]"))) {
    const input = box.querySelector<HTMLInputElement>("input");
    if (!input) continue;
    const set = (n: number) => {
      input.value = String(Math.max(1, Math.min(999, Math.round(n) || 1)));
      box.querySelector<HTMLButtonElement>("[data-ct-qty-step='-1']")?.toggleAttribute("disabled", Number(input.value) <= 1);
    };
    for (const b of Array.from(box.querySelectorAll<HTMLButtonElement>("[data-ct-qty-step]"))) {
      b.addEventListener("click", () => set(Number(input.value) + Number(b.dataset.ctQtyStep)));
    }
    input.addEventListener("change", () => set(Number(input.value)));
    set(Number(input.value));
  }
}

// ---------------------------------------------------------------------------
// Sale countdown + delivery estimate
// ---------------------------------------------------------------------------

export function initExtras(root: HTMLElement): void {
  const pad = (n: number) => String(n).padStart(2, "0");
  for (const timer of Array.from(root.querySelectorAll<HTMLElement>("[data-ct-countdown]"))) {
    const end = new Date(timer.dataset.ctCountdown ?? "").getTime();
    if (Number.isNaN(end)) {
      timer.hidden = true;
      continue;
    }
    const part = (k: string) => timer.querySelector<HTMLElement>(`[data-${k}]`);
    const tick = () => {
      let s = Math.max(0, Math.floor((end - Date.now()) / 1000));
      if (s === 0) {
        timer.closest(".ct-sale")?.querySelector(".ct-sale__label")?.remove();
        timer.remove();
        window.clearInterval(id);
        return;
      }
      const d = Math.floor(s / 86400);
      s %= 86400;
      const days = part("d");
      if (days) {
        days.textContent = pad(d);
        if (days.parentElement) days.parentElement.hidden = d === 0;
      }
      const h = part("h");
      if (h) h.textContent = pad(Math.floor(s / 3600));
      const m = part("m");
      if (m) m.textContent = pad(Math.floor((s % 3600) / 60));
      const sec = part("s");
      if (sec) sec.textContent = pad(s % 60);
    };
    const id = window.setInterval(tick, 1000);
    tick();
  }

  const addBusinessDays = (from: Date, n: number) => {
    const d = new Date(from);
    while (n > 0) {
      d.setDate(d.getDate() + 1);
      if (d.getDay() % 6 !== 0) n--;
    }
    return d;
  };
  for (const box of Array.from(root.querySelectorAll<HTMLElement>("[data-ct-delivery]"))) {
    const range = box.querySelector<HTMLElement>("[data-ct-delivery-range]");
    if (!range) continue;
    const now = new Date();
    const a = addBusinessDays(now, Number(box.dataset.min) || 0);
    const b = addBusinessDays(now, Number(box.dataset.max) || 0);
    const mon = (d: Date) => d.toLocaleDateString("en-US", { month: "short" });
    range.textContent = mon(a) === mon(b) ? `${mon(a)} ${a.getDate()}–${b.getDate()}` : `${mon(a)} ${a.getDate()} – ${mon(b)} ${b.getDate()}`;
  }
}

// ---------------------------------------------------------------------------
// Sticky Add to cart bar
// ---------------------------------------------------------------------------

/** Shown while the real Add to cart button is off screen; its button submits the real form (same validation). */
export function initSticky(root: HTMLElement, form: HTMLFormElement): void {
  const bar = root.querySelector<HTMLElement>("[data-ct-sticky]");
  const anchor = form.querySelector<HTMLButtonElement>('[type="submit"]');
  if (!bar || !anchor) return;
  const button = bar.querySelector<HTMLButtonElement>("[data-ct-sticky-add]");
  button?.addEventListener("click", () => {
    if (anchor.disabled) return;
    form.requestSubmit(anchor);
  });
  // Mirrors the real button (sold out / label).
  const mirror = () => {
    if (!button) return;
    const loading = anchor.classList.contains("ct-loading-btn") || anchor.classList.contains("ct-adding");
    button.disabled = anchor.disabled && !loading;
    const label = anchor.querySelector("[data-ct-submit-label]")?.textContent ?? "";
    const own = button.querySelector("[data-ct-sticky-label]");
    if (own && label.trim()) own.textContent = label.trim();
    button.classList.toggle("ct-loading-btn", loading);
  };
  new MutationObserver(mirror).observe(anchor, { attributes: true, childList: true, subtree: true, characterData: true });
  mirror();

  const show = (visible: boolean) => {
    bar.classList.toggle("is-visible", visible);
    bar.setAttribute("aria-hidden", visible ? "false" : "true");
    if (button) button.tabIndex = visible ? 0 : -1;
  };
  // Only once the customer has scrolled past the button (not before reaching it at the top of the page). A scroll
  // listener, not an IntersectionObserver: a fast scroll that jumps over the button never crosses its threshold.
  let queued = false;
  const check = () => {
    queued = false;
    show(anchor.getBoundingClientRect().bottom < 0);
  };
  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(check);
  };
  window.addEventListener("scroll", queue, { passive: true });
  window.addEventListener("resize", queue);
  check();
}

// ---------------------------------------------------------------------------
// Cart drawer
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/** A visible property value: uploaded files / links are shown as a short "View" link. */
function propertyValue(v: string): string {
  return /^https?:\/\//i.test(v) ? `<a href="${esc(v)}" target="_blank" rel="noopener">View</a>` : esc(v);
}

class CartDrawer {
  private readonly panel: HTMLElement;
  private readonly body: HTMLElement;
  private readonly total: HTMLElement;
  private readonly count: HTMLElement | null;
  private readonly moneyFormat: string;
  private lastFocus: Element | null = null;
  private busy = false;

  constructor(
    private readonly drawer: HTMLElement,
    moneyFormat: string,
  ) {
    this.panel = drawer.querySelector<HTMLElement>("[data-ct-drawer-panel]") ?? drawer;
    this.body = drawer.querySelector<HTMLElement>("[data-ct-drawer-items]") ?? drawer;
    this.total = drawer.querySelector<HTMLElement>("[data-ct-drawer-total]") ?? drawer;
    this.count = drawer.querySelector<HTMLElement>("[data-ct-drawer-count]");
    this.moneyFormat = moneyFormat;
    // On the body: a sticky / transformed ancestor would clip a fixed panel.
    if (drawer.parentElement !== document.body) document.body.appendChild(drawer);
    for (const c of Array.from(drawer.querySelectorAll("[data-ct-drawer-close]"))) c.addEventListener("click", () => this.close());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.isOpen()) this.close();
    });
    this.body.addEventListener("click", (e) => void this.onItemClick(e));
    // The header's cart icon opens this drawer on this page (the theme's own drawer still holds the cart from page load).
    document.addEventListener(
      "click",
      (e) => {
        const link = (e.target as Element | null)?.closest?.(`#${HEADER_BUBBLE}, a[href$="/cart"][id*="cart-icon"]`);
        if (!link || drawer.contains(link)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        void this.open();
      },
      true,
    );
  }

  isOpen(): boolean {
    return this.drawer.classList.contains("is-open");
  }

  async open(): Promise<void> {
    this.lastFocus = document.activeElement;
    // The cart first (a fast /cart.js): the panel slides in already filled.
    await this.refresh();
    this.drawer.hidden = false;
    // Next frame: the slide-in transition needs the un-hidden state painted first.
    requestAnimationFrame(() => this.drawer.classList.add("is-open"));
    document.documentElement.classList.add("ct-drawer-lock");
    this.panel.focus({ preventScroll: true });
  }

  close(): void {
    this.drawer.classList.remove("is-open");
    document.documentElement.classList.remove("ct-drawer-lock");
    window.setTimeout(() => {
      if (!this.isOpen()) this.drawer.hidden = true;
    }, 300);
    if (this.lastFocus instanceof HTMLElement) this.lastFocus.focus({ preventScroll: true });
  }

  async refresh(): Promise<void> {
    try {
      const res = await fetch("/cart.js", { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
      if (res.ok) this.render((await res.json()) as ShopifyCart);
    } catch (err) {
      console.warn("[ct] cart refresh failed", err);
    }
  }

  private money(cents: number): string {
    return formatMoney(cents, this.moneyFormat);
  }

  private render(cart: ShopifyCart): void {
    if (this.count) this.count.textContent = cart.item_count > 0 ? `(${cart.item_count})` : "";
    this.total.textContent = this.money(cart.total_price);
    this.drawer.classList.toggle("is-empty", cart.items.length === 0);
    if (cart.items.length === 0) {
      this.body.innerHTML = `<p class="ct-drawer__empty">${esc(this.drawer.dataset.ctEmpty || "Your cart is empty")}</p>`;
      return;
    }
    this.body.innerHTML = cart.items
      .map((item) => {
        const props = Object.entries(item.properties ?? {}).filter(([k, v]) => !k.startsWith("_") && String(v ?? "").trim() !== "");
        const image = item.properties?._ct_preview || item.image || "";
        const variant = item.variant_title && item.variant_title !== "Default Title" ? item.variant_title : "";
        const compare = item.original_line_price > item.final_line_price ? `<s>${esc(this.money(item.original_line_price))}</s>` : "";
        return `
          <div class="ct-drawer__item" data-key="${esc(item.key)}">
            <a class="ct-drawer__thumb" href="${esc(item.url)}">${image ? `<img src="${esc(image)}" alt="" loading="lazy">` : ""}</a>
            <div class="ct-drawer__info">
              <a class="ct-drawer__title" href="${esc(item.url)}">${esc(item.product_title)}</a>
              ${variant ? `<p class="ct-drawer__meta">${esc(variant)}</p>` : ""}
              ${props.map(([k, v]) => `<p class="ct-drawer__meta"><span>${esc(k)}:</span> ${propertyValue(String(v))}</p>`).join("")}
              <p class="ct-drawer__price">${esc(this.money(item.final_line_price))} ${compare}</p>
              <div class="ct-drawer__row">
                <div class="ct-qty__box ct-qty__box--sm">
                  <button type="button" data-ct-line-step="-1" aria-label="Decrease quantity">−</button>
                  <span aria-live="polite">${item.quantity}</span>
                  <button type="button" data-ct-line-step="1" aria-label="Increase quantity">+</button>
                </div>
                <button type="button" class="ct-drawer__remove" data-ct-line-remove>Remove</button>
              </div>
            </div>
          </div>`;
      })
      .join("");
  }

  private async onItemClick(e: Event): Promise<void> {
    const target = e.target as Element | null;
    const row = target?.closest<HTMLElement>(".ct-drawer__item");
    if (!row || this.busy) return;
    const key = row.dataset.key ?? "";
    const qty = Number(row.querySelector(".ct-qty__box span")?.textContent ?? "1");
    let quantity: number | null = null;
    const step = target?.closest<HTMLElement>("[data-ct-line-step]");
    if (step) quantity = Math.max(0, qty + Number(step.dataset.ctLineStep));
    if (target?.closest("[data-ct-line-remove]")) quantity = 0;
    if (quantity === null) return;
    this.busy = true;
    row.classList.add("is-busy");
    try {
      const res = await fetch("/cart/change.js", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ id: key, quantity, sections: HEADER_BUBBLE }),
      });
      if (!res.ok) throw new Error(await errorText(res, "Could not update the cart."));
      const cart = (await res.json()) as ShopifyCart & ShopifyAddResponse;
      updateHeaderBubble(cart.sections);
      this.render(cart);
    } catch (err) {
      console.warn("[ct] cart change failed", err);
      row.classList.remove("is-busy");
    } finally {
      this.busy = false;
    }
  }
}

/**
 * Add to cart through /cart/add.js and open the section's drawer. Runs in the bubble phase: the
 * Customizer's capture-phase handler has already validated, uploaded and written the line properties
 * (it lets this second submit through). Without a drawer in the markup the form posts as usual (/cart).
 */
export function initCart(root: HTMLElement, form: HTMLFormElement): void {
  const drawerEl = root.querySelector<HTMLElement>("[data-ct-drawer]");
  if (!drawerEl) return;
  const drawer = new CartDrawer(drawerEl, root.dataset.ctMoneyFormat || "${{amount}}");
  const errorBox = root.querySelector<HTMLElement>("[data-ct-cart-error]");
  let busy = false;
  form.addEventListener("submit", (e) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    if (busy) return;
    const button = (e.submitter as HTMLButtonElement | null) ?? form.querySelector<HTMLButtonElement>('[type="submit"]');
    busy = true;
    // Own class: the Customizer's submit clears ct-loading-btn right after handing this submit over.
    button?.classList.add("ct-adding");
    if (errorBox) errorBox.hidden = true;
    const body = new FormData(form);
    body.append("sections", HEADER_BUBBLE);
    body.append("sections_url", window.location.pathname);
    void (async () => {
      try {
        const res = await fetch("/cart/add.js", { method: "POST", body, credentials: "same-origin", headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error(await errorText(res, "Could not add to cart."));
        updateHeaderBubble(((await res.json()) as ShopifyAddResponse).sections);
        await drawer.open();
      } catch (err) {
        if (errorBox) {
          errorBox.textContent = err instanceof Error ? err.message : String(err);
          errorBox.hidden = false;
        }
      } finally {
        busy = false;
        button?.classList.remove("ct-adding");
      }
    })();
  });
}
