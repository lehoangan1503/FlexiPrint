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
  dismissed?: boolean;
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

export const taskWorking = (t: CtPhotoTask) => t.stage === "style" || t.stage === "phoi" || !!t.phoiPending;

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

// ---------------------------------------------------------------------------------------------------------- cards

const CSS = `
.f2t{position:fixed;top:14px;right:14px;z-index:2147483000;display:flex;flex-direction:column;gap:10px;width:min(340px,calc(100vw - 28px));pointer-events:none;font-family:inherit}
.f2t__item{pointer-events:auto;display:flex;gap:12px;align-items:center;padding:10px 12px 10px 10px;border-radius:16px;background:#fff;color:#1d1d1f;box-shadow:0 10px 30px rgba(20,16,40,.18),0 1px 3px rgba(0,0,0,.08);text-decoration:none;position:relative;animation:f2t-in .35s cubic-bezier(.2,.9,.3,1.2);border:1px solid rgba(0,0,0,.06)}
.f2t__item:hover{box-shadow:0 14px 34px rgba(20,16,40,.24)}
.f2t__thumb{position:relative;flex:none;width:64px;height:64px;border-radius:12px;overflow:hidden;background:#f3f1ee}
.f2t__thumb img{width:100%;height:100%;object-fit:cover;display:block}
.f2t__spin{position:absolute;inset:0;display:grid;place-items:center;background:rgba(30,24,60,.45)}
.f2t__spin::after{content:"";width:24px;height:24px;border-radius:50%;border:3px solid rgba(255,255,255,.35);border-top-color:#fff;animation:f2t-rot .9s linear infinite}
.f2t__body{min-width:0;flex:1;display:flex;flex-direction:column;gap:3px}
.f2t__title{font-size:13px;font-weight:600;line-height:1.3;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.f2t__status{font-size:12px;line-height:1.35;color:#6b6b72}
.f2t__item.is-ready .f2t__status{color:#1a7f37;font-weight:600}
.f2t__item.is-failed .f2t__status{color:#b42318}
.f2t__item.is-ready{box-shadow:0 0 0 2px #f3b46a,0 12px 32px rgba(229,121,59,.28)}
.f2t__close{position:absolute;top:4px;right:6px;width:22px;height:22px;border:0;background:transparent;color:#9a9aa1;font-size:16px;line-height:22px;cursor:pointer;border-radius:50%}
.f2t__close:hover{background:#f1f1f3;color:#333}
@keyframes f2t-in{from{opacity:0;transform:translateX(24px) scale(.96)}to{opacity:1;transform:none}}
@keyframes f2t-rot{to{transform:rotate(360deg)}}
@media (max-width:600px){.f2t{top:auto;bottom:12px;right:12px}}
`;

function samePage(url: string): boolean {
  try {
    return new URL(url, location.href).pathname.replace(/\/$/, "") === location.pathname.replace(/\/$/, "");
  } catch {
    return false;
  }
}

function openUrl(t: CtStoredTask): string {
  const u = new URL(t.productUrl, location.href);
  u.searchParams.set(TASK_PARAM, t.id);
  return u.toString();
}

function card(t: CtStoredTask): HTMLElement {
  const working = t.task.stage === "style" || t.task.stage === "phoi";
  const failed = t.task.stage === "failed";
  const a = document.createElement("a");
  a.className = `f2t__item${failed ? " is-failed" : working ? "" : " is-ready"}`;
  a.href = openUrl(t);
  const thumb = document.createElement("span");
  thumb.className = "f2t__thumb";
  const img = document.createElement("img");
  img.alt = "";
  img.src = working ? t.productImage : resultImage(t);
  thumb.append(img);
  if (working) thumb.append(Object.assign(document.createElement("span"), { className: "f2t__spin" }));
  const body = document.createElement("span");
  body.className = "f2t__body";
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
  body.append(title, status);
  const close = Object.assign(document.createElement("button"), { type: "button", className: "f2t__close", textContent: "×", title: "Dismiss" });
  close.setAttribute("aria-label", "Dismiss");
  close.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    updateTask(t.id, { dismissed: true });
  });
  a.append(thumb, body, close);
  return a;
}

declare global {
  interface Window {
    __flexi2Tasks?: boolean;
  }
}

/** The card stack + the poller, once per page. */
export function startTaskCenter(): void {
  if (window.__flexi2Tasks) return;
  window.__flexi2Tasks = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
  const host = document.createElement("div");
  host.className = "f2t";
  host.setAttribute("aria-live", "polite");
  const mount = () => {
    if (!host.isConnected) document.body.append(host);
  };
  const render = () => {
    mount();
    // The product being looked at shows its own progress on the page: no card for it here.
    const shown = loadTasks()
      .filter((t) => !t.dismissed && !samePage(t.productUrl))
      .slice(-4)
      .reverse();
    host.replaceChildren(...shown.map(card));
  };
  onTasks(render);
  if (document.body) render();
  else document.addEventListener("DOMContentLoaded", render, { once: true });

  let busy = false;
  const tick = async () => {
    if (busy || document.hidden) return;
    busy = true;
    try {
      await Promise.all(loadTasks().filter((t) => taskWorking(t.task) && t.task.stage !== "failed").map(pollOnce));
    } finally {
      busy = false;
    }
  };
  setInterval(() => void tick(), POLL_MS);
  document.addEventListener("visibilitychange", () => void tick());
  void tick();
}
