"use client";

/**
 * In-app replacements for window.confirm / prompt / alert — same look as
 * CtModal, awaited the same way:
 *
 *   if (!(await ctConfirm({ title: "Xoá clipart?", message: "…", tone: "danger", confirmLabel: "Xoá" }))) return;
 *   const name = await ctPrompt({ title: "Sản phẩm mới", label: "Tên", defaultValue: "…" });
 *   await ctAlert({ title: "Không lưu được", message: "…" });
 *
 * One host is mounted on first use (its own React root on document.body).
 * Radix keeps one stack of layers / focus scopes per page, so a dialog opened
 * from inside another modal stacks above it and closing it leaves that modal open.
 */

import * as React from "react";
import { createRoot } from "react-dom/client";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AlertTriangle, Info, Trash2 } from "lucide-react";
import { CtButton, CtInput, cx } from "./ui";

export type CtDialogTone = "info" | "warning" | "danger";

export interface CtConfirmOptions {
  title: string;
  /** Plain text keeps its line breaks. */
  message?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: CtDialogTone;
}

export interface CtPromptOptions {
  title: string;
  message?: React.ReactNode;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface CtChoice<T extends string> {
  value: T;
  label: string;
  variant?: "primary" | "danger" | "outline";
}

export interface CtChooseOptions<T extends string> {
  title: string;
  message?: React.ReactNode;
  tone?: CtDialogTone;
  /** Left to right; the last one is the default (Enter). Esc / outside = null. */
  choices: Array<CtChoice<T>>;
}

export interface CtAlertOptions {
  title: string;
  message?: React.ReactNode;
  okLabel?: string;
  tone?: CtDialogTone;
}

type Request = { id: number } & (
  | { kind: "confirm"; opts: CtConfirmOptions; resolve: (v: boolean) => void }
  | { kind: "prompt"; opts: CtPromptOptions; resolve: (v: string | null) => void }
  | { kind: "alert"; opts: CtAlertOptions; resolve: () => void }
  | { kind: "choose"; opts: CtChooseOptions<string>; resolve: (v: string | null) => void }
);

let nextId = 1;

let push: ((r: Request) => void) | null = null;
const pending: Request[] = [];
let mounted = false;

function enqueue(r: Request): void {
  if (push) return push(r);
  // Host mounting: it picks these up once its effect runs.
  pending.push(r);
  if (mounted || typeof document === "undefined") return;
  mounted = true;
  const el = document.createElement("div");
  el.dataset.ctDialogs = "";
  document.body.appendChild(el);
  createRoot(el).render(<Host />);
}

export function ctConfirm(opts: CtConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => enqueue({ id: nextId++, kind: "confirm", opts, resolve }));
}

/** The text entered, or null when cancelled. */
export function ctPrompt(opts: CtPromptOptions): Promise<string | null> {
  return new Promise((resolve) => enqueue({ id: nextId++, kind: "prompt", opts, resolve }));
}

/** One of `choices` (its value), or null when dismissed. */
export function ctChoose<T extends string>(opts: CtChooseOptions<T>): Promise<T | null> {
  return new Promise((resolve) => enqueue({ id: nextId++, kind: "choose", opts, resolve: (v) => resolve(v as T | null) }));
}

export function ctAlert(opts: CtAlertOptions): Promise<void> {
  return new Promise((resolve) => enqueue({ id: nextId++, kind: "alert", opts, resolve }));
}

const TONE: Record<CtDialogTone, { icon: typeof Info; className: string }> = {
  info: { icon: Info, className: "bg-sky-500/15 text-sky-500" },
  warning: { icon: AlertTriangle, className: "bg-amber-500/15 text-amber-500" },
  danger: { icon: Trash2, className: "bg-destructive/15 text-destructive" },
};

function Host() {
  const [queue, setQueue] = React.useState<Request[]>(() => pending.splice(0));
  React.useEffect(() => {
    push = (r) => setQueue((q) => [...q, r]);
    if (pending.length) setQueue((q) => [...q, ...pending.splice(0)]);
    return () => {
      push = null;
    };
  }, []);
  const cur = queue[0];
  if (!cur) return null;
  // Keyed per request: a prompt's text starts from its own default.
  return <RequestDialog key={cur.id} cur={cur} onDone={() => setQueue((q) => q.slice(1))} />;
}

function RequestDialog({ cur, onDone }: { cur: Request; onDone: () => void }) {
  const [text, setText] = React.useState(cur.kind === "prompt" ? (cur.opts.defaultValue ?? "") : "");
  const done = (ok: boolean) => {
    if (cur.kind === "confirm") cur.resolve(ok);
    else if (cur.kind === "prompt") cur.resolve(ok ? text : null);
    else if (cur.kind === "choose") cur.resolve(ok ? (cur.opts.choices[cur.opts.choices.length - 1]?.value ?? null) : null);
    else cur.resolve();
    onDone();
  };
  const tone: CtDialogTone = cur.kind === "prompt" ? "info" : (cur.opts.tone ?? (cur.kind === "alert" ? "info" : "warning"));
  const confirmLabel = cur.kind === "confirm" ? cur.opts.confirmLabel : cur.kind === "prompt" ? cur.opts.confirmLabel : undefined;
  const { icon: Icon, className } = TONE[tone];
  const message = cur.opts.message;

  return (
    <DialogPrimitive.Root open onOpenChange={(o) => !o && done(false)}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-black/60" />
        <DialogPrimitive.Content
          className="fixed left-1/2 top-1/2 z-[60] w-[min(460px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border bg-background p-5 shadow-2xl"
          // Only its buttons / Esc answer it — a stray click outside is not a "cancel".
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          onOpenAutoFocus={(e) => {
            // A prompt focuses its input; otherwise the safe button (cancel), not the destructive one.
            if (cur.kind !== "prompt") return;
            e.preventDefault();
            requestAnimationFrame(() => document.querySelector<HTMLInputElement>("[data-ct-prompt-input]")?.select());
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              done(true);
            }}
          >
            <div className="flex gap-3">
              <div className={cx("flex h-9 w-9 shrink-0 items-center justify-center rounded-full", className)}>
                <Icon className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                <DialogPrimitive.Title className="text-base font-semibold leading-snug">{cur.opts.title}</DialogPrimitive.Title>
                {message ? (
                  <DialogPrimitive.Description asChild>
                    <div className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">{message}</div>
                  </DialogPrimitive.Description>
                ) : (
                  <DialogPrimitive.Description className="sr-only">{cur.opts.title}</DialogPrimitive.Description>
                )}
                {cur.kind === "prompt" && (
                  <label className="block space-y-1">
                    {cur.opts.label && <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{cur.opts.label}</span>}
                    <CtInput data-ct-prompt-input value={text} placeholder={cur.opts.placeholder} onChange={(e) => setText(e.target.value)} />
                  </label>
                )}
              </div>
            </div>
            {cur.kind === "choose" ? (
              <div className="mt-5 flex flex-wrap justify-end gap-2">
                {cur.opts.choices.map((c, i) => (
                  <CtButton
                    key={c.value}
                    type={i === cur.opts.choices.length - 1 ? "submit" : "button"}
                    variant={c.variant ?? (i === cur.opts.choices.length - 1 ? "primary" : "outline")}
                    onClick={
                      i === cur.opts.choices.length - 1
                        ? undefined
                        : () => {
                            cur.resolve(c.value);
                            onDone();
                          }
                    }
                  >
                    {c.label}
                  </CtButton>
                ))}
              </div>
            ) : (
            <div className="mt-5 flex justify-end gap-2">
              {(cur.kind === "confirm" || cur.kind === "prompt") && (
                <CtButton onClick={() => done(false)}>{cur.opts.cancelLabel ?? "Huỷ"}</CtButton>
              )}
              <CtButton
                type="submit"
                variant={tone === "danger" ? "danger" : "primary"}
                disabled={cur.kind === "prompt" && !text.trim()}
              >
                {cur.kind === "alert" ? (cur.opts.okLabel ?? "OK") : (confirmLabel ?? "Đồng ý")}
              </CtButton>
            </div>
            )}
          </form>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
