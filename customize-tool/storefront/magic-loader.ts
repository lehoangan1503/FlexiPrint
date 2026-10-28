/**
 * The wait while a customer's photo is redrawn (asked 2026-10-28 — the boss disliked a bar stuck at 95 % while the AI
 * still works): no percentage at all. A small sky of constellations whose stars twinkle through the RGB colours, linked
 * by faint lines that breathe, a shooting star now and then, the store's name shimmering ("Cherivia magic") and a line
 * saying what is happening that changes every few seconds — it never looks frozen however long the model takes.
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

export interface MagicLoader {
  root: HTMLElement;
  /** Show it with this line (its rotating lines follow when `steps` are given). */
  show: (text: string, steps?: string[]) => void;
  hide: () => void;
}

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

export function createMagicLoader(brand: string): MagicLoader {
  loadBrandFont();
  const root = document.createElement("div");
  root.className = "ct-magic";
  root.hidden = true;
  const canvas = document.createElement("canvas");
  canvas.className = "ct-magic__sky";
  const title = document.createElement("div");
  title.className = "ct-magic__brand";
  title.textContent = brand;
  const line = document.createElement("div");
  line.className = "ct-magic__line";
  root.append(canvas, title, line);

  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ctx = canvas.getContext("2d");
  let stars: Star[] = [];
  let shooting: Shooting | null = null;
  let frame = 0;
  let w = 0;
  let h = 0;
  let stepTimer = 0;

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

  const stopSteps = () => {
    window.clearInterval(stepTimer);
    stepTimer = 0;
  };

  return {
    root,
    show(text, steps) {
      line.textContent = text;
      stopSteps();
      if (steps?.length) {
        let i = 0;
        stepTimer = window.setInterval(() => {
          i = (i + 1) % steps.length;
          line.classList.remove("is-in");
          // Restart the fade-in.
          void line.offsetWidth;
          line.textContent = steps[i];
          line.classList.add("is-in");
        }, 3600);
      }
      if (!root.hidden) return;
      root.hidden = false;
      if (!stars.length) seed();
      fit();
      cancelAnimationFrame(frame);
      if (reduced) draw(performance.now());
      else frame = requestAnimationFrame(loop);
    },
    hide() {
      root.hidden = true;
      stopSteps();
      cancelAnimationFrame(frame);
    },
  };
}
