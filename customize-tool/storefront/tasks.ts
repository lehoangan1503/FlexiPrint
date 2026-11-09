/**
 * The customer's background photo tasks on the store (2026-11-09, asked: "các hoạt ảnh generate chạy ngầm … khi các tác
 * vụ chạy ngầm xong sẽ có ô sticky card bên phải top thông báo các sản phẩm (thumb sản phẩm đã render ảnh khách) …
 * khách có thể làm nhiều sản phẩm mà không phải đợi"):
 *
 *   - every task (server/photo-tasks.ts) is remembered in localStorage with the product it belongs to and the design
 *     to bring back, so it lives on across pages and tabs
 *   - one poller per page asks the server about the unfinished ones and tells the page (event "flexi2:tasks")
 *   - a card stack top-right shows them: working (the product photo + a spinner), ready (the piece with the customer's
 *     photo) → a tap opens the product with the design filled in (?flexi2_task=<id>, storefront/customizer.ts)
 *
 * Bundled twice: into flexi2-customizer.js (product pages) and alone as flexi2-tasks.js (every page, layout/theme.liquid);
 * a page that loads both runs one centre (window.__flexi2Tasks).
 */

import type { CtPhotoTask, CtSelection, CtTransform } from "../types";

const STORE_KEY = "flexi2:tasks";
const EVENT = "flexi2:tasks";
const POLL_MS = 3500;
const KEEP_MS = 24 * 60 * 60_000;
export const TASK_PARAM = "flexi2_task";

export interface CtStoredTask {
  id: string;
  /** GET url of the task (public/tasks/:id). */
  poll: string;
  productUrl: string;
  productTitle: string;
  productImage: string;
  /** The style's name ("Dog + Santa Hat"). */
  styleName: string;
  /** The design to bring back when the customer opens it again (texts included), photo zone excluded. */
  selection: CtSelection;
  /** Where the customer placed the photo (identity = as big as the zone allows). */
  transform: CtTransform;
  optionId: string | null;
  task: CtPhotoTask;
  createdAt: number;
  /** × on its card: gone from the list (and not brought back on its product page). */
  dismissed?: boolean;
  /** Its "ready" was shown (the list opened for it, or the customer was on its page). */
  notified?: boolean;
}

export function loadTasks(): CtStoredTask[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const list = raw ? (JSON.parse(raw) as CtStoredTask[]) : [];
    const now = Date.now();
    return Array.isArray(list) ? list.filter((t) => t && typeof t.id === "string" && now - t.createdAt < KEEP_MS) : [];
  } catch {
    return [];
  }
}

function saveAll(list: CtStoredTask[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(-20)));
  } catch {
    // Private mode / full storage: the page still works, the task is only not remembered.
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function addTask(t: CtStoredTask): void {
  saveAll([...loadTasks().filter((x) => x.id !== t.id), t]);
}

export function updateTask(id: string, patch: Partial<CtStoredTask>): CtStoredTask | null {
  const list = loadTasks();
  const i = list.findIndex((t) => t.id === id);
  if (i < 0) return null;
  list[i] = { ...list[i], ...patch };
  saveAll(list);
  return list[i];
}

export function getTask(id: string): CtStoredTask | null {
  return loadTasks().find((t) => t.id === id) ?? null;
}

/** Called on every change (this page's own, other tabs'); returns the unsubscribe. */
export function onTasks(cb: () => void): () => void {
  const storage = (e: StorageEvent) => {
    if (e.key === STORE_KEY) cb();
  };
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", storage);
  };
}

export const taskWorking = (t: CtPhotoTask) => t.stage !== "failed" && (t.stage === "style" || t.stage === "phoi" || !!t.phoiPending);
/** Finished with something to show (the piece with the photo, or at least the photo). */
export const taskReady = (t: CtPhotoTask) => !taskWorking(t) && t.stage === "done" && !!(t.phoi || t.photoUrl);

/** A product page, whatever its query (a preview link) — the tasks of one product are grouped by it. */
export function pageKey(url: string): string {
  try {
    return new URL(url, location.href).pathname.replace(/\/$/, "");
  } catch {
    return url;
  }
}

/** The newest task of the product page open now (2026-11-10: "data render phải persist reload không mất"). */
export function latestForPage(): CtStoredTask | null {
  const here = pageKey(location.href);
  const mine = loadTasks().filter((t) => !t.dismissed && t.task.stage !== "failed" && pageKey(t.productUrl) === here);
  return mine.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

/** Newest first, one per product (its newest task). */
function byProduct(list: CtStoredTask[]): CtStoredTask[] {
  const seen = new Set<string>();
  const out: CtStoredTask[] = [];
  for (const t of [...list].sort((a, b) => b.createdAt - a.createdAt)) {
    const k = pageKey(t.productUrl);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/** The picture of a finished task: the piece with the photo, else the photo alone. */
const resultImage = (t: CtStoredTask) => t.task.phoi?.url ?? t.task.photoUrl ?? t.productImage;

// ---------------------------------------------------------------------------------------------------------- poller

async function pollOnce(t: CtStoredTask): Promise<void> {
  try {
    const res = await fetch(t.poll, { mode: "cors", cache: "no-store" });
    if (res.status === 404) {
      updateTask(t.id, { task: { ...t.task, stage: "failed", phoiPending: null, error: "This preview expired — please upload the photo again." } });
      return;
    }
    if (!res.ok) return;
    const body = (await res.json()) as { task?: CtPhotoTask };
    if (body.task && body.task.updatedAt !== t.task.updatedAt) updateTask(t.id, { task: body.task });
  } catch {
    // Offline for a moment: asked again on the next round.
  }
}

// ---------------------------------------------------------------------------------------------------------- list
/*
 * 2026-11-10 (asked: "card to hơn nhưng ngắn chiều ngang hơn, có nút toggle show hide full list. Sau khi hoàn thành
 * hết có 1 sticky tròn button hiển thị số lượng sản phẩm khách đã test mà có preview"):
 *   - a round button (the newest result, a spinning ring while anything works, the count of products with a preview)
 *     opens / closes the list under it
 *   - the list: tall narrow cards (the picture full width), the newest two, "Show all (n)" / "Show less"
 *   - it opens by itself when a task starts or one finishes, and folds back into the round button a few seconds
 *     after everything is done
 */

const UI_KEY = "flexi2:tasks-ui";
const FEW = 2;
const FOLD_MS = 9000;

interface CtTasksUi {
  open: boolean;
  all: boolean;
}

function loadUi(): CtTasksUi {
  try {
    const raw = sessionStorage.getItem(UI_KEY);
    const ui = raw ? (JSON.parse(raw) as Partial<CtTasksUi>) : {};
    return { open: ui.open === true, all: ui.all === true };
  } catch {
    return { open: false, all: false };
  }
}

function saveUi(ui: CtTasksUi): void {
  try {
    sessionStorage.setItem(UI_KEY, JSON.stringify(ui));
  } catch {
    // Not remembered across pages: fine.
  }
}

const CSS = `
.f2t{position:fixed;top:112px;right:16px;z-index:2147483000;display:flex;flex-direction:column;align-items:flex-end;gap:10px;pointer-events:none;font-family:inherit;color:#1d1d1f}
.f2t[hidden]{display:none}
.f2t__fab{pointer-events:auto;position:relative;width:62px;height:62px;padding:0;border:0;border-radius:50%;background:#fff;cursor:pointer;box-shadow:0 8px 24px rgba(20,16,40,.22),0 1px 3px rgba(0,0,0,.1);animation:f2t-in .35s cubic-bezier(.2,.9,.3,1.2)}
.f2t__fab img{position:absolute;inset:4px;width:54px;height:54px;border-radius:50%;object-fit:cover;display:block}
.f2t__ring{position:absolute;inset:0;border-radius:50%;border:3px solid transparent;pointer-events:none}
.f2t.is-working .f2t__ring{border-color:rgba(229,121,59,.25);border-top-color:#e5793b;animation:f2t-rot 1s linear infinite}
.f2t__count{position:absolute;top:-4px;right:-4px;min-width:24px;height:24px;padding:0 6px;border-radius:12px;background:#e5793b;color:#fff;font-size:13px;font-weight:700;line-height:24px;text-align:center;box-shadow:0 0 0 2px #fff}
.f2t__count[hidden]{display:none}
.f2t__panel{pointer-events:auto;width:212px;max-height:calc(100vh - 200px);overflow-y:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:10px;padding:10px;border-radius:18px;background:rgba(255,255,255,.97);box-shadow:0 14px 40px rgba(20,16,40,.22),0 1px 3px rgba(0,0,0,.08);border:1px solid rgba(0,0,0,.06);animation:f2t-in .3s cubic-bezier(.2,.9,.3,1.2)}
.f2t__panel[hidden]{display:none}
.f2t__head{display:flex;align-items:center;justify-content:space-between;padding:0 2px;font-size:13px;font-weight:700}
.f2t__min{width:26px;height:26px;border:0;border-radius:50%;background:#f1f1f3;color:#555;font-size:16px;line-height:26px;cursor:pointer;padding:0}
.f2t__item{position:relative;display:flex;flex-direction:column;gap:6px;padding:6px 6px 10px;border-radius:14px;background:#fff;color:inherit;text-decoration:none;border:1px solid rgba(0,0,0,.07)}
.f2t__item:hover{box-shadow:0 6px 18px rgba(20,16,40,.14)}
.f2t__item.is-ready{border-color:#f3b46a;box-shadow:0 0 0 1px #f3b46a}
.f2t__thumb{position:relative;display:block;width:100%;aspect-ratio:1;border-radius:10px;overflow:hidden;background:#f3f1ee}
.f2t__thumb img{width:100%;height:100%;object-fit:cover;display:block}
.f2t__spin{position:absolute;inset:0;display:grid;place-items:center;background:rgba(30,24,60,.45)}
.f2t__spin::after{content:"";width:30px;height:30px;border-radius:50%;border:3px solid rgba(255,255,255,.35);border-top-color:#fff;animation:f2t-rot .9s linear infinite}
.f2t__title{padding:0 4px;font-size:13px;font-weight:600;line-height:1.3;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.f2t__status{padding:0 4px;font-size:12px;line-height:1.35;color:#6b6b72}
.f2t__item.is-ready .f2t__status{color:#1a7f37;font-weight:600}
.f2t__item.is-failed .f2t__status{color:#b42318}
.f2t__close{position:absolute;top:10px;right:10px;width:24px;height:24px;border:0;border-radius:50%;background:rgba(255,255,255,.9);color:#666;font-size:15px;line-height:24px;cursor:pointer;padding:0;box-shadow:0 1px 4px rgba(0,0,0,.18)}
.f2t__close:hover{color:#111}
.f2t__more{border:0;background:#f4f2ef;border-radius:10px;padding:8px;font:inherit;font-size:12px;font-weight:600;color:#333;cursor:pointer}
.f2t__more:hover{background:#ebe7e1}
@keyframes f2t-in{from{opacity:0;transform:translateY(-8px) scale(.96)}to{opacity:1;transform:none}}
@keyframes f2t-rot{to{transform:rotate(360deg)}}
@media (max-width:600px){.f2t{top:auto;bottom:14px;right:12px;flex-direction:column-reverse}.f2t__panel{width:180px;max-height:calc(100vh - 120px)}}
`;

function openUrl(t: CtStoredTask): string {
  const u = new URL(t.productUrl, location.href);
  u.searchParams.set(TASK_PARAM, t.id);
  return u.toString();
}

function card(t: CtStoredTask): HTMLElement {
  const working = taskWorking(t.task);
  const failed = t.task.stage === "failed";
  const a = document.createElement("a");
  a.className = `f2t__item${failed ? " is-failed" : working ? "" : " is-ready"}`;
  a.href = openUrl(t);
  const thumb = document.createElement("span");
  thumb.className = "f2t__thumb";
  const img = document.createElement("img");
  img.alt = "";
  img.loading = "lazy";
  img.src = working ? t.productImage || resultImage(t) : resultImage(t);
  thumb.append(img);
  if (working) thumb.append(Object.assign(document.createElement("span"), { className: "f2t__spin" }));
  const title = Object.assign(document.createElement("span"), { className: "f2t__title", textContent: t.productTitle });
  const status = Object.assign(document.createElement("span"), {
    className: "f2t__status",
    textContent: failed
      ? "Couldn't finish — tap to try again"
      : working
        ? t.task.stage === "style"
          ? `Creating ${t.styleName || "your design"}…`
          : "Making your realistic preview…"
        : "Your design is ready ✨ Tap to view",
  });
  const close = Object.assign(document.createElement("button"), { type: "button", className: "f2t__close", textContent: "×", title: "Remove" });
  close.setAttribute("aria-label", "Remove");
  close.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    updateTask(t.id, { dismissed: true });
  });
  a.append(thumb, title, status, close);
  return a;
}

declare global {
  interface Window {
    __flexi2Tasks?: boolean;
  }
}

/** The round button + the list + the poller, once per page. */
export function startTaskCenter(): void {
  if (window.__flexi2Tasks) return;
  window.__flexi2Tasks = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);

  const host = document.createElement("div");
  host.className = "f2t";
  host.hidden = true;
  host.setAttribute("aria-live", "polite");
  const fabImg = document.createElement("img");
  fabImg.alt = "";
  const count = Object.assign(document.createElement("span"), { className: "f2t__count" });
  const fab = Object.assign(document.createElement("button"), { type: "button", className: "f2t__fab" });
  fab.append(fabImg, Object.assign(document.createElement("span"), { className: "f2t__ring" }), count);
  const panel = Object.assign(document.createElement("div"), { className: "f2t__panel" });
  const listBox = Object.assign(document.createElement("div"), { className: "f2t__list" });
  listBox.style.cssText = "display:flex;flex-direction:column;gap:10px";
  const more = Object.assign(document.createElement("button"), { type: "button", className: "f2t__more" });
  const min = Object.assign(document.createElement("button"), { type: "button", className: "f2t__min", textContent: "–", title: "Hide" });
  min.setAttribute("aria-label", "Hide");
  const headText = document.createElement("span");
  const head = Object.assign(document.createElement("div"), { className: "f2t__head" });
  head.append(headText, min);
  panel.append(head, listBox, more);
  host.append(fab, panel);

  let ui = loadUi();
  const setUi = (patch: Partial<CtTasksUi>) => {
    ui = { ...ui, ...patch };
    saveUi(ui);
    render();
  };
  let hovering = false;
  let fold = 0;
  /** The list was opened by itself (a task started / finished), not by the customer: it folds back when all is done. */
  let auto = false;
  host.addEventListener("mouseenter", () => (hovering = true));
  host.addEventListener("mouseleave", () => (hovering = false));
  fab.addEventListener("click", () => {
    window.clearTimeout(fold);
    fold = 0;
    auto = false;
    setUi({ open: !ui.open });
  });
  min.addEventListener("click", () => {
    auto = false;
    setUi({ open: false });
  });
  more.addEventListener("click", () => setUi({ all: !ui.all }));

  /** Ids known on this page: a new one (a task just started) opens the list. */
  let known: Set<string> | null = null;
  const foldLater = () => {
    if (fold) return;
    fold = window.setTimeout(function again() {
      const busy = loadTasks().some((t) => !t.dismissed && taskWorking(t.task));
      if (busy) return;
      if (hovering) {
        fold = window.setTimeout(again, 2500);
        return;
      }
      fold = 0;
      auto = false;
      setUi({ open: false });
    }, FOLD_MS);
  };

  function render(): void {
    if (!host.isConnected) document.body.append(host);
    const all = loadTasks().filter((t) => !t.dismissed);
    const list = byProduct(all);
    const here = pageKey(location.href);
    if (!list.length) {
      host.hidden = true;
      known = new Set();
      return;
    }
    host.hidden = false;
    const working = list.some((t) => taskWorking(t.task));
    // Started since this page opened → show it; finished and not announced yet → show it, then fold back.
    // A task started on this very page is watched in its photo dialog: no list for it.
    const started = known !== null && all.some((t) => !known?.has(t.id) && pageKey(t.productUrl) !== here);
    const firstPaint = known === null;
    // Left open on the page before: it folds back by itself once all is done.
    if (firstPaint && ui.open) auto = true;
    known = new Set(all.map((t) => t.id));
    const fresh = all.filter((t) => taskReady(t.task) && !t.notified);
    const announce = fresh.filter((t) => pageKey(t.productUrl) !== here);
    if (fresh.length) {
      // One write for all of them (it calls render again, with nothing fresh left).
      const ids = new Set(fresh.map((t) => t.id));
      queueMicrotask(() => {
        const next = loadTasks().map((t) => (ids.has(t.id) ? { ...t, notified: true } : t));
        try {
          localStorage.setItem(STORE_KEY, JSON.stringify(next.slice(-20)));
        } catch {
          // ignore
        }
      });
    }
    if (started || announce.length) {
      ui = { ...ui, open: true };
      saveUi(ui);
      auto = true;
    } else if (firstPaint && !working && ui.open) {
      // Everything was already done when this page opened: the round button only.
      ui = { ...ui, open: false };
      saveUi(ui);
    }

    if (auto && ui.open && !working) foldLater();
    // Not over the photo dialog of the product page.
    host.style.visibility = document.querySelector("dialog.ct-dialog") ? "hidden" : "";
    const ready = list.filter((t) => taskReady(t.task));
    host.classList.toggle("is-working", working);
    host.classList.toggle("is-open", ui.open);
    const top = ready[0] ?? list[0];
    const pic = taskReady(top.task) ? resultImage(top) : top.productImage || resultImage(top);
    if (fabImg.getAttribute("src") !== pic) fabImg.src = pic;
    count.hidden = !ready.length;
    count.textContent = String(ready.length);
    const label = working ? "Your designs — one is still being made" : `Your designs (${ready.length})`;
    fab.title = label;
    fab.setAttribute("aria-label", label);
    fab.setAttribute("aria-expanded", String(ui.open));
    panel.hidden = !ui.open;
    headText.textContent = `Your designs (${list.length})`;
    const shown = ui.all ? list : list.slice(0, FEW);
    listBox.replaceChildren(...shown.map(card));
    more.hidden = list.length <= FEW;
    more.textContent = ui.all ? "Show less" : `Show all (${list.length})`;
  }

  onTasks(render);
  const begin = () => {
    render();
    // The photo dialogs come and go on <body>.
    new MutationObserver(() => {
      const hide = !!document.querySelector("dialog.ct-dialog");
      if ((host.style.visibility === "hidden") !== hide) host.style.visibility = hide ? "hidden" : "";
    }).observe(document.body, { childList: true });
  };
  if (document.body) begin();
  else document.addEventListener("DOMContentLoaded", begin, { once: true });

  let busy = false;
  const tick = async () => {
    if (busy || document.hidden) return;
    busy = true;
    try {
      await Promise.all(loadTasks().filter((t) => taskWorking(t.task)).map(pollOnce));
    } finally {
      busy = false;
    }
  };
  setInterval(() => void tick(), POLL_MS);
  document.addEventListener("visibilitychange", () => void tick());
  void tick();
}
