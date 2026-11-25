/**
 * The wait while a customer's photo is redrawn. A small sky of constellations whose stars twinkle through the RGB
 * colours, the store's name shimmering ("Cherivia magic"), and (asked 2026-11-25, replacing the "no percentage" wait
 * of 2026-10-28 — customers thought the page had frozen):
 *  - the customer's own photo in the middle, a light sweeping over it and fading toward a sketch, never stretched;
 *  - a percentage bar that runs fast then slower, reaches 90 % at `expect` seconds and then holds under 95 % — it
 *    reaches 100 % only through finish(), i.e. when the real picture is there;
 *  - the line under it changes at percentage marks (steps), and after `slowAfter` seconds says "almost there";
 *  - fail(): a plain message and a "Try again" button instead of a wait that never ends.
 * Animates only while shown (requestAnimationFrame stops when hidden), honours prefers-reduced-motion.
 */

interface Star {
  x: number;
  y: number;
  r: number;
  hue: number;
  phase: number;
  speed: number;
}

interface Shooting {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  hue: number;
}

/** A line shown from this percentage on. */
export interface MagicStep {
  at: number;
  text: string;
}

export interface MagicWait {
  /** The line at 0 %. */
  text: string;
  /** Lines by percentage mark (after `text`). */
  steps?: MagicStep[];
  /** Seconds to reach 90 % (the average real wait). */
  expect?: number;
  /** The customer's photo shown in the middle (none: the sky alone). */
  photo?: string | null;
  /** After this many seconds the line says `slowText`. */
  slowAfter?: number;
  slowText?: string;
}

export interface MagicLoader {
  root: HTMLElement;
  /** Start a wait (the bar from 0 %). */
  show: (wait: MagicWait) => void;
  /** Real progress is known: the bar is at least this percentage (kept under 95 %). */
  reach: (percent: number) => void;
  /** The picture is there: the bar runs to 100 %, then resolves (the caller hides it). */
  finish: () => Promise<void>;
  /** Stop with a plain message and a "Try again" button. */
  fail: (message: string, retryLabel: string, onRetry: () => void) => void;
  hide: () => void;
}

/** The bar never passes this before finish(). */
const HOLD = 95;
/** How long the bar takes to fill the last bit once the picture is there (ms). */
const FINISH_MS = 450;

const STARS = 46;
/** Stars closer than this (share of the box's smaller side) are joined into constellations. */
const LINK = 0.2;

/** The script face of the store's name (once per page). */
function loadBrandFont(): void {
  if (document.querySelector('link[href*="Great+Vibes"]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "https://fonts.googleapis.com/css2?family=Great+Vibes&display=swap";
  document.head.append(link);
}

/**
 * The brand is drawn in a script font, where capitals run into each other ("CHERIVIA" is unreadable): a word written
 * all in capitals is shown as "Cherivia". Mixed-case words are left as they are.
 */
function scriptCase(text: string): string {
  return text.replace(/\p{L}{2,}/gu, (w) => (w === w.toUpperCase() && w !== w.toLowerCase() ? w[0] + w.slice(1).toLowerCase() : w));
}

export function createMagicLoader(brand: string): MagicLoader {
  loadBrandFont();
  const root = document.createElement("div");
  root.className = "ct-magic";
  root.hidden = true;
  const canvas = document.createElement("canvas");
  canvas.className = "ct-magic__sky";
  const title = document.createElement("div");
  title.className = "ct-magic__brand";
  title.textContent = scriptCase(brand);
  const line = document.createElement("div");
  line.className = "ct-magic__line";
  line.setAttribute("aria-live", "polite");
  // The customer's photo: sized by fitPhoto() to the room left (contain — portrait or landscape, never stretched).
  const photoBox = document.createElement("div");
  photoBox.className = "ct-magic__photo";
  const frameEl = document.createElement("div");
  frameEl.className = "ct-magic__frame";
  const img = document.createElement("img");
  img.className = "ct-magic__img";
  img.alt = "";
  img.decoding = "async";
  const sweep = document.createElement("span");
  sweep.className = "ct-magic__sweep";
  frameEl.append(img, sweep);
  photoBox.append(frameEl);
  // The bar + its percentage.
  const bar = document.createElement("div");
  bar.className = "ct-magic__bar";
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  const track = document.createElement("div");
  track.className = "ct-magic__track";
  const fillEl = document.createElement("div");
  fillEl.className = "ct-magic__fill";
  track.append(fillEl);
  const pct = document.createElement("span");
  pct.className = "ct-magic__pct";
  bar.append(track, pct);
  // A failure: what happened + Try again.
  const error = document.createElement("div");
  error.className = "ct-magic__error";
  error.hidden = true;
  const errorText = document.createElement("p");
  errorText.className = "ct-magic__error-text";
  errorText.setAttribute("role", "alert");
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "ct-btn ct-btn--primary ct-magic__retry";
  error.append(errorText, retry);
  root.append(canvas, title, photoBox, line, bar, error);

  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ctx = canvas.getContext("2d");
  let stars: Star[] = [];
  let shooting: Shooting | null = null;
  let frame = 0;
  let w = 0;
  let h = 0;
  /** The wait being shown, when it started (ms, performance.now), its time constant (s) and the bar's last value. */
  let wait: MagicWait | null = null;
  let started = 0;
  /** When the wait began (the "almost there" line counts from here; reach() moves `started` only). */
  let began = 0;
  let tau = 30;
  let shown = 0;
  let tick = 0;
  let onRetry: (() => void) | null = null;

  const fitPhoto = () => {
    if (photoBox.hidden || !img.naturalWidth || !img.naturalHeight) return;
    const room = photoBox.getBoundingClientRect();
    const k = Math.min(room.width / img.naturalWidth, room.height / img.naturalHeight);
    if (!(k > 0)) return;
    img.style.width = `${Math.max(1, Math.floor(img.naturalWidth * k))}px`;
    img.style.height = `${Math.max(1, Math.floor(img.naturalHeight * k))}px`;
  };
  img.addEventListener("load", () => {
    frameEl.classList.add("is-ready");
    fitPhoto();
  });
  const watch = typeof ResizeObserver === "function" ? new ResizeObserver(() => fitPhoto()) : null;
  watch?.observe(photoBox);

  /** Seconds → percentage: fast first, slower and slower, 90 % at `expect`, never HOLD. */
  const curve = (sec: number) => HOLD * (1 - Math.exp(-sec / tau));
  const setBar = (p: number) => {
    shown = p;
    const n = Math.floor(p);
    fillEl.style.width = `${p}%`;
    pct.textContent = `${n}%`;
    bar.setAttribute("aria-valuenow", String(n));
  };
  const setLine = (text: string) => {
    if (line.textContent === text) return;
    line.classList.remove("is-in");
    // Restart the fade-in.
    void line.offsetWidth;
    line.textContent = text;
    line.classList.add("is-in");
  };
  const lineFor = (p: number, sec: number): string => {
    if (!wait) return "";
    if (wait.slowText && sec >= (wait.slowAfter ?? 180)) return wait.slowText;
    let text = wait.text;
    for (const s of wait.steps ?? []) if (p >= s.at) text = s.text;
    return text;
  };
  const update = () => {
    if (!wait) return;
    const now = performance.now();
    // Never backwards, never HOLD or more.
    const p = Math.min(HOLD - 0.5, Math.max(shown, curve((now - started) / 1000)));
    setBar(p);
    setLine(lineFor(p, (now - began) / 1000));
  };
  const stopTick = () => {
    window.clearInterval(tick);
    tick = 0;
  };

  const seed = () => {
    stars = Array.from({ length: STARS }, () => ({
      x: Math.random(),
      y: Math.random(),
      r: 0.6 + Math.random() * 1.6,
      hue: Math.random() * 360,
      phase: Math.random() * Math.PI * 2,
      speed: 0.6 + Math.random() * 1.6,
    }));
  };

  const fit = () => {
    const box = root.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    w = Math.max(1, box.width);
    h = Math.max(1, box.height);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const draw = (now: number) => {
    if (!ctx) return;
    const t = now / 1000;
    ctx.clearRect(0, 0, w, h);
    const side = Math.min(w, h);
    const pts = stars.map((s) => ({
      x: s.x * w,
      y: s.y * h,
      // The colour runs round the wheel (red → green → blue…), each star from its own place.
      hue: (s.hue + t * 70) % 360,
      glow: 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * s.speed * 2.2 + s.phase)),
      r: s.r,
    }));
    // Constellation lines: faint, breathing, coloured between their two stars.
    ctx.lineWidth = 0.8;
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i];
        const b = pts[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y) / side;
        if (d > LINK) continue;
        const alpha = (1 - d / LINK) * 0.45 * Math.min(a.glow, b.glow);
        const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
        g.addColorStop(0, `hsla(${a.hue},100%,70%,${alpha})`);
        g.addColorStop(1, `hsla(${b.hue},100%,70%,${alpha})`);
        ctx.strokeStyle = g;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    // The stars: a soft halo and a bright core; the brightest flash a little cross.
    for (const p of pts) {
      const halo = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 7);
      halo.addColorStop(0, `hsla(${p.hue},100%,75%,${0.55 * p.glow})`);
      halo.addColorStop(1, `hsla(${p.hue},100%,60%,0)`);
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `hsla(${p.hue},100%,92%,${0.6 + 0.4 * p.glow})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (0.7 + 0.5 * p.glow), 0, Math.PI * 2);
      ctx.fill();
      if (p.glow > 0.92 && p.r > 1.4) {
        const len = p.r * 6 * p.glow;
        ctx.strokeStyle = `hsla(${p.hue},100%,90%,${(p.glow - 0.92) * 8})`;
        ctx.beginPath();
        ctx.moveTo(p.x - len, p.y);
        ctx.lineTo(p.x + len, p.y);
        ctx.moveTo(p.x, p.y - len);
        ctx.lineTo(p.x, p.y + len);
        ctx.stroke();
      }
    }
    // Now and then a shooting star.
    if (!shooting && Math.random() < 0.008) shooting = { x: Math.random() * w * 0.6, y: Math.random() * h * 0.3, vx: w * 0.012, vy: h * 0.006, life: 1, hue: Math.random() * 360 };
    if (shooting) {
      const s = shooting;
      const g = ctx.createLinearGradient(s.x, s.y, s.x - s.vx * 8, s.y - s.vy * 8);
      g.addColorStop(0, `hsla(${s.hue},100%,85%,${s.life})`);
      g.addColorStop(1, `hsla(${s.hue},100%,70%,0)`);
      ctx.strokeStyle = g;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x - s.vx * 8, s.y - s.vy * 8);
      ctx.stroke();
      s.x += s.vx;
      s.y += s.vy;
      s.life -= 0.02;
      if (s.life <= 0 || s.x > w || s.y > h) shooting = null;
    }
    // The stars drift very slowly, so the sky is never the same.
    for (const s of stars) {
      s.x += 0.00004 * s.speed;
      if (s.x > 1.02) s.x = -0.02;
    }
  };

  const loop = (now: number) => {
    draw(now);
    frame = requestAnimationFrame(loop);
  };

  retry.addEventListener("click", () => onRetry?.());

  const startSky = () => {
    if (!stars.length) seed();
    fit();
    cancelAnimationFrame(frame);
    if (reduced) draw(performance.now());
    else frame = requestAnimationFrame(loop);
  };

  return {
    root,
    show(next) {
      wait = next;
      // 90 % at `expect` seconds: HOLD·(1 − e^(−expect/τ)) = 90.
      tau = Math.max(1, next.expect ?? 90) / Math.log(HOLD / (HOLD - 90));
      started = performance.now();
      began = started;
      onRetry = null;
      root.classList.remove("is-failed", "is-done");
      error.hidden = true;
      bar.hidden = false;
      line.hidden = false;
      fillEl.style.transition = "none";
      setBar(0);
      void fillEl.offsetWidth;
      fillEl.style.transition = "";
      line.textContent = "";
      setLine(next.text);
      const src = next.photo || "";
      photoBox.hidden = !src;
      if (src && img.getAttribute("src") !== src) {
        frameEl.classList.remove("is-ready");
        img.removeAttribute("style");
        img.src = src;
      }
      stopTick();
      tick = window.setInterval(update, 200);
      const wasHidden = root.hidden;
      root.hidden = false;
      // The room for the photo is known only once it is on the page.
      requestAnimationFrame(fitPhoto);
      if (wasHidden) startSky();
    },
    reach(percent) {
      if (!wait) return;
      const p = Math.min(HOLD - 0.5, percent);
      if (curve((performance.now() - started) / 1000) >= p) return;
      // Move the start back so the curve is there now (it slows down from here as before).
      const sec = -tau * Math.log(1 - p / HOLD);
      started = performance.now() - sec * 1000;
      update();
    },
    finish() {
      stopTick();
      if (root.hidden || !wait) return Promise.resolve();
      wait = null;
      root.classList.add("is-done");
      setBar(100);
      return new Promise((resolve) => window.setTimeout(resolve, reduced ? 0 : FINISH_MS));
    },
    fail(message, retryLabel, cb) {
      stopTick();
      wait = null;
      onRetry = cb;
      root.classList.add("is-failed");
      errorText.textContent = message;
      retry.textContent = retryLabel;
      error.hidden = false;
      bar.hidden = true;
      line.hidden = true;
      if (root.hidden) {
        root.hidden = false;
        startSky();
      }
      requestAnimationFrame(fitPhoto);
    },
    hide() {
      root.hidden = true;
      wait = null;
      onRetry = null;
      stopTick();
      cancelAnimationFrame(frame);
    },
  };
}
