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
  /** Its "ready" was shown (the list opened for it, or the customer watched it in its photo dialog). */
  notified?: boolean;
  /** Its start was shown (the list opened with its running card). */
  announced?: boolean;
  /** The progress bar's current leg: since when (ms) and from how far (0–1) — set when the phôi starts drawing. */
  bar?: { at: number; from: number };
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
    // 40: a product with many photo slots (the multi-photo popup, 11 on a blanket) + a few retries still fits.
    localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(-40)));
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

/** Every task of the product page open now, newest first (failed ones too) — the multi-photo popup brings them all back. */
export function tasksForPage(): CtStoredTask[] {
  const here = pageKey(location.href);
  return loadTasks()
    .filter((t) => !t.dismissed && pageKey(t.productUrl) === here)
    .sort((a, b) => b.createdAt - a.createdAt);
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

/**
 * How far a running task looks (0–1), for its moving bar: the server says only the stage, so the bar eases toward the
 * stage's usual end (the style ~30 s, the phôi ~2 min) and never reaches the end before the task does.
 */
export function progressOf(t: CtStoredTask, now = Date.now()): number {
  if (!taskWorking(t.task)) return 1;
  const phoi = t.task.stage === "phoi" || !!t.task.phoiPending;
  const leg = t.bar ?? { at: t.createdAt, from: 0 };
  const el = Math.max(0, now - leg.at);
  const span = phoi ? 0.97 - leg.from : 0.9 - leg.from;
  return Math.max(0.04, leg.from + Math.max(0, span) * (1 - Math.exp(-el / (phoi ? 60_000 : 18_000))));
}

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
    if (!body.task || body.task.updatedAt === t.task.updatedAt) return;
    const wasPhoi = t.task.stage === "phoi" || !!t.task.phoiPending;
    const isPhoi = body.task.stage === "phoi" || !!body.task.phoiPending;
    // The phôi starts: the bar goes on from where it is, toward the phôi's longer end.
    const bar = isPhoi && !wasPhoi ? { at: Date.now(), from: Math.min(0.9, progressOf(t)) } : t.bar;
    updateTask(t.id, { task: body.task, bar });
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

/*
 * 2026-11-17 (asked: "chỗ này có cái gì chạy chạy cho ngta biết đang chạy … sợ nó quay quay bên góc này bọn nó ko
 * nhìn thấy … quay xong em cho hiện card sản phẩm luôn, không muốn xem ngay thì thu nhỏ lại"):
 *   - a task that starts opens the list with its card and a moving bar (also on its own product page, once its photo
 *     dialog is closed — "Buy More")
 *   - folded while one runs, the round button carries a "Creating…" pill with the same moving bar
 *   - when it is done the list opens with the finished card and STAYS open until the customer taps "Minimize"
 *     (no folding by itself any more); one the customer watched finish in its photo dialog is not announced again
 */

const UI_KEY = "flexi2:tasks-ui";
const FEW = 2;

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
.f2t__head{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:0 2px;font-size:13px;font-weight:700}
.f2t__head>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.f2t__min{border:0;background:#f1f1f3;color:#555;cursor:pointer}
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
.f2t__bar{display:block;position:relative;height:6px;margin:0 4px;border-radius:3px;background:#f1e6dc;overflow:hidden}
.f2t__bar i{position:absolute;inset:0 auto 0 0;width:4%;border-radius:3px;background:linear-gradient(90deg,#f0a35e,#e5793b);transition:width .6s ease-out;overflow:hidden}
.f2t__bar i::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.65),transparent);transform:translateX(-100%);animation:f2t-shine 1.3s linear infinite}
.f2t__pill{position:absolute;right:calc(100% + 10px);top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:5px;width:max-content;max-width:170px;padding:8px 12px;border-radius:14px;background:#fff;box-shadow:0 6px 20px rgba(20,16,40,.2),0 1px 3px rgba(0,0,0,.08);font-size:12px;font-weight:600;line-height:1.25;text-align:left;color:#1d1d1f;pointer-events:none}
.f2t__pill[hidden]{display:none}
.f2t__pill .f2t__bar{margin:0;width:130px;max-width:100%}
.f2t.is-working .f2t__fab{animation:f2t-in .35s cubic-bezier(.2,.9,.3,1.2),f2t-pulse 1.8s ease-out infinite}
.f2t__min{width:auto;height:28px;padding:0 10px 0 8px;border-radius:14px;font-size:12px;font-weight:600;line-height:28px;display:inline-flex;align-items:center;gap:4px;flex-shrink:0;white-space:nowrap}
.f2t__min:hover{background:#e6e6ea;color:#111}
.f2t__more{border:0;background:#f4f2ef;border-radius:10px;padding:8px;font:inherit;font-size:12px;font-weight:600;color:#333;cursor:pointer}
.f2t__more:hover{background:#ebe7e1}
@keyframes f2t-in{from{opacity:0;transform:translateY(-8px) scale(.96)}to{opacity:1;transform:none}}
@keyframes f2t-rot{to{transform:rotate(360deg)}}
@keyframes f2t-shine{to{transform:translateX(100%)}}
@keyframes f2t-pulse{0%{box-shadow:0 8px 24px rgba(20,16,40,.22),0 0 0 0 rgba(229,121,59,.55)}70%{box-shadow:0 8px 24px rgba(20,16,40,.22),0 0 0 14px rgba(229,121,59,0)}100%{box-shadow:0 8px 24px rgba(20,16,40,.22),0 0 0 0 rgba(229,121,59,0)}}
@media (max-width:600px){.f2t{top:auto;bottom:14px;right:12px;flex-direction:column-reverse}.f2t__panel{width:206px;max-height:calc(100vh - 120px)}}
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
  a.append(thumb, title, status);
  if (working) {
    const bar = Object.assign(document.createElement("span"), { className: "f2t__bar" });
    const fill = document.createElement("i");
    fill.dataset.f2tTask = t.id;
    fill.style.width = `${Math.round(progressOf(t) * 100)}%`;
    bar.append(fill);
    a.append(bar);
  }
  a.append(close);
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
  // Folded while one runs: "Creating…" and a moving bar beside the round button, so it is seen, not only a ring.
  const pillText = document.createElement("span");
  const pillFill = document.createElement("i");
  const pillBar = Object.assign(document.createElement("span"), { className: "f2t__bar" });
  pillBar.append(pillFill);
  const pill = Object.assign(document.createElement("span"), { className: "f2t__pill" });
  pill.append(pillText, pillBar);
  const fab = Object.assign(document.createElement("button"), { type: "button", className: "f2t__fab" });
  fab.append(fabImg, Object.assign(document.createElement("span"), { className: "f2t__ring" }), count, pill);
  const panel = Object.assign(document.createElement("div"), { className: "f2t__panel" });
  const listBox = Object.assign(document.createElement("div"), { className: "f2t__list" });
  listBox.style.cssText = "display:flex;flex-direction:column;gap:10px";
  const more = Object.assign(document.createElement("button"), { type: "button", className: "f2t__more" });
  const min = Object.assign(document.createElement("button"), { type: "button", className: "f2t__min", textContent: "– Minimize", title: "Minimize" });
  min.setAttribute("aria-label", "Minimize");
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
  fab.addEventListener("click", () => setUi({ open: !ui.open }));
  min.addEventListener("click", () => setUi({ open: false }));
  more.addEventListener("click", () => setUi({ all: !ui.all }));
  // Opening a card = it was seen: the next page starts with the round button only.
  listBox.addEventListener("click", (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target || target.closest(".f2t__close") || !target.closest(".f2t__item")) return;
    ui = { ...ui, open: false };
    saveUi(ui);
  });

  const dialogOpen = () => !!document.querySelector("dialog.ct-dialog");

  function render(): void {
    if (!host.isConnected) document.body.append(host);
    const all = loadTasks().filter((t) => !t.dismissed);
    const list = byProduct(all);
    if (!list.length) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    const here = pageKey(location.href);
    const inDialog = dialogOpen();
    // Shown by itself: a task that started (its running card) and one that finished (its result) — never over a photo
    // dialog; one that finished while the customer watched it in its own photo dialog is not announced again.
    const marks = new Map<string, Partial<CtStoredTask>>();
    let pop = false;
    for (const t of all) {
      if (taskReady(t.task)) {
        if (t.notified) continue;
        if (!inDialog) pop = true;
        else if (pageKey(t.productUrl) !== here) continue;
        marks.set(t.id, { notified: true, announced: true });
      } else if (taskWorking(t.task) && !t.announced && !inDialog) {
        marks.set(t.id, { announced: true });
        pop = true;
      }
    }
    if (marks.size) {
      // Straight into storage (no event: this render already shows them).
      const next = loadTasks().map((t) => ({ ...t, ...marks.get(t.id) }));
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(next.slice(-20)));
      } catch {
        // ignore
      }
    }
    if (pop && !ui.open) {
      ui = { ...ui, open: true };
      saveUi(ui);
    }

    host.style.visibility = inDialog ? "hidden" : "";
    const ready = list.filter((t) => taskReady(t.task));
    const running = list.find((t) => taskWorking(t.task)) ?? null;
    host.classList.toggle("is-working", !!running);
    host.classList.toggle("is-open", ui.open);
    const top = ready[0] ?? list[0];
    const pic = taskReady(top.task) ? resultImage(top) : top.productImage || resultImage(top);
    if (fabImg.getAttribute("src") !== pic) fabImg.src = pic;
    count.hidden = !ready.length;
    count.textContent = String(ready.length);
    const label = running ? "Your designs — one is still being made" : `Your designs (${ready.length})`;
    fab.title = label;
    fab.setAttribute("aria-label", label);
    fab.setAttribute("aria-expanded", String(ui.open));
    pill.hidden = ui.open || !running;
    if (running) {
      pillText.textContent = running.task.stage === "style" ? `Creating ${running.styleName || "your design"}…` : "Making your preview…";
      pillFill.dataset.f2tTask = running.id;
      pillFill.style.width = `${Math.round(progressOf(running) * 100)}%`;
    }
    panel.hidden = !ui.open;
    headText.textContent = `Your designs (${list.length})`;
    const shown = ui.all ? list : list.slice(0, FEW);
    listBox.replaceChildren(...shown.map(card));
    more.hidden = list.length <= FEW;
    more.textContent = ui.all ? "Show less" : `Show all (${list.length})`;
  }

  // The bars move between the polls.
  window.setInterval(() => {
    if (host.hidden || document.hidden) return;
    const fills = Array.from(host.querySelectorAll<HTMLElement>("i[data-f2t-task]"));
    if (!fills.length) return;
    const byId = new Map(loadTasks().map((t) => [t.id, t]));
    for (const f of fills) {
      const t = byId.get(f.dataset.f2tTask ?? "");
      if (t) f.style.width = `${Math.round(progressOf(t) * 100)}%`;
    }
  }, 700);

  onTasks(render);
  const begin = () => {
    render();
    // The photo dialogs come and go on <body>: closed ("Buy More") = the running card shows now.
    let wasOpen = dialogOpen();
    new MutationObserver(() => {
      const open = dialogOpen();
      if (open === wasOpen) return;
      wasOpen = open;
      render();
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
