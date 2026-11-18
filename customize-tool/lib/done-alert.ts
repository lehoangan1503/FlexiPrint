/**
 * "Done" alert for AI work (asked 2026-11-18: "mỗi cái tạo AI gen có âm báo … chỉ kích hoạt khi tab đó không hoạt
 * động, người dùng đang dùng tab khác" + "tab nhấp nháy để editor biết tab nào rồi click vào xem kết quả"):
 * when a long AI job ends while this tab is hidden, a short chime plays (Web Audio, no sound file) and the tab title
 * blinks "✅ … xong" until the tab is looked at again. Nothing at all while the editor is on the tab.
 *
 * Called by lib/job-fetch (every POST that went to a background job) and useDoneAlert (screens that poll a running job).
 */

let audio: AudioContext | null = null;
let blink: ReturnType<typeof setInterval> | null = null;
let title = "";
let done = 0;
let failed = 0;

/** The browser lets a page make sound only after the user touched it: the audio is opened on the first click. */
function unlock(): void {
  if (audio || typeof window === "undefined") return;
  const Ctx = window.AudioContext;
  if (!Ctx) return;
  try {
    audio = new Ctx();
  } catch {
    audio = null;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", unlock, { once: true, capture: true });
  window.addEventListener("keydown", unlock, { once: true, capture: true });
}

/** Two soft notes: rising = done, falling = failed. */
function chime(ok: boolean): void {
  if (!audio) return;
  void audio.resume().catch(() => undefined);
  const notes = ok ? [659.25, 987.77] : [523.25, 349.23];
  const start = audio.currentTime + 0.02;
  notes.forEach((freq, i) => {
    if (!audio) return;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    const at = start + i * 0.16;
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.18, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.5);
    osc.connect(gain).connect(audio.destination);
    osc.start(at);
    osc.stop(at + 0.55);
  });
}

function stopBlink(): void {
  if (blink) clearInterval(blink);
  blink = null;
  if (title) document.title = title;
  title = "";
  done = 0;
  failed = 0;
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) stopBlink();
  });
}

/** An AI job ended (ok = its result came, else it failed). Only acts when the tab is hidden. */
export function aiDone(ok = true): void {
  if (typeof document === "undefined" || !document.hidden) return;
  chime(ok);
  if (ok) done++;
  else failed++;
  if (!title) title = document.title;
  const text = [done ? `✅ ${done > 1 ? `${done} việc AI` : "AI"} xong` : "", failed ? `⚠️ ${failed} lỗi` : ""].filter(Boolean).join(" · ");
  if (blink) clearInterval(blink);
  let on = true;
  document.title = text;
  blink = setInterval(() => {
    on = !on;
    document.title = on ? text : title;
  }, 1000);
}
