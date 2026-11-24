"use client";

/**
 * UI primitives for the Customize Tool — shadcn/ui components (Radix + the
 * host's Tailwind tokens) copied in rather than imported from
 * `@/components/ui`, so the folder can be lifted into its own app.
 */

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as SelectPrimitive from "@radix-ui/react-select";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Check, ChevronDown, ChevronLeft, ChevronRight, ExternalLink, X } from "lucide-react";
import { twMerge } from "tailwind-merge";

/** Class joiner; later classes win over conflicting earlier ones (`w-full` + `w-64` → `w-64`). */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return twMerge(parts.filter(Boolean).join(" "));
}

type ButtonVariant = "primary" | "outline" | "ghost" | "danger" | "subtle";
type ButtonSize = "sm" | "md" | "icon";

export interface CtButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  active?: boolean;
}

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-foreground text-background hover:opacity-90",
  outline: "border border-input bg-transparent hover:bg-accent",
  ghost: "bg-transparent hover:bg-accent",
  danger: "bg-destructive text-destructive-foreground hover:opacity-90",
  subtle: "bg-muted hover:bg-accent",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "h-8 px-2.5 text-xs gap-1.5 pointer-coarse:h-10",
  md: "h-9 px-3.5 text-sm gap-2 pointer-coarse:h-10",
  icon: "h-8 w-8 justify-center pointer-coarse:h-10 pointer-coarse:w-10",
};

export const CtButton = React.forwardRef<HTMLButtonElement, CtButtonProps>(function CtButton(
  { variant = "outline", size = "md", active, className, type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        "inline-flex items-center rounded-md font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none whitespace-nowrap",
        VARIANT[variant],
        SIZE[size],
        active && "ring-2 ring-sky-500 bg-sky-500/15",
        className,
      )}
      {...props}
    />
  );
});

export const CtInput = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function CtInput(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cx(
        "h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm outline-none focus:ring-2 focus:ring-sky-500/60 pointer-coarse:h-10 pointer-coarse:text-base",
        className,
      )}
      {...props}
    />
  );
});

export const CtTextarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function CtTextarea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={cx(
          "w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-sky-500/60 pointer-coarse:text-base",
          className,
        )}
        {...props}
      />
    );
  },
);

export interface CtSelectOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
  /** Draw the item's label in this font (a font list previews each font). */
  fontFamily?: string;
}

/** shadcn Select. Radix forbids "" as an item value, so an empty value shows the placeholder. */
export function CtSelect<T extends string>({
  value,
  onChange,
  options,
  className,
  placeholder = "Chọn…",
  disabled,
  ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<CtSelectOption<T>>;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Name read by screen readers when no visible label sits next to the box. */
  ariaLabel?: string;
}) {
  const known = options.some((o) => o.value === value);
  return (
    <SelectPrimitive.Root value={known ? value : undefined} onValueChange={(v) => onChange(v as T)} disabled={disabled}>
      <SelectPrimitive.Trigger
        aria-label={ariaLabel}
        className={cx(
          "flex h-8 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-2 text-sm pointer-coarse:h-10 pointer-coarse:text-base",
          "hover:border-muted-foreground/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60",
          "disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-muted-foreground [&>span]:truncate [&>span]:text-left",
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon asChild>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className={cx(
            "relative z-[200] max-h-80 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          )}
        >
          <SelectPrimitive.Viewport className="p-1">
            {options.map((o) => (
              <SelectPrimitive.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                className={cx(
                  "relative flex w-full cursor-pointer select-none items-center rounded-sm py-1.5 pl-2 pr-8 text-sm outline-none",
                  "focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
                )}
              >
                <SelectPrimitive.ItemText>
                  <span style={o.fontFamily ? { fontFamily: `"${o.fontFamily}", sans-serif` } : undefined}>{o.label}</span>
                </SelectPrimitive.ItemText>
                <span className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
                  <SelectPrimitive.ItemIndicator>
                    <Check className="h-3.5 w-3.5" />
                  </SelectPrimitive.ItemIndicator>
                </span>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

/** Mount once near the root; `delayDuration={0}` makes tooltips appear on hover immediately. */
export function CtTooltipProvider({ children }: { children: React.ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={0} skipDelayDuration={0}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

/**
 * shadcn Tooltip around one trigger element. `shortcut` renders as key caps,
 * e.g. shortcut={["⌘", "Z"]}.
 */
export function CtTooltip({
  label,
  shortcut,
  side = "bottom",
  children,
}: {
  label: React.ReactNode;
  shortcut?: string[];
  side?: "top" | "bottom" | "left" | "right";
  children: React.ReactElement;
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-[300] flex items-center gap-2 rounded-md bg-foreground px-2 py-1 text-xs text-background shadow-md animate-in fade-in-0 zoom-in-95"
        >
          <span>{label}</span>
          {shortcut && shortcut.length > 0 && (
            <span className="flex gap-0.5">
              {shortcut.map((k, i) => (
                <CtKbd key={i}>{k}</CtKbd>
              ))}
            </span>
          )}
          <TooltipPrimitive.Arrow className="fill-foreground" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export function CtKbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-background/30 bg-background/15 px-1 font-sans text-[10px] font-medium leading-none">
      {children}
    </kbd>
  );
}

/**
 * Input as wide as its text (plus a little), capped at `maxWidth`; overflow
 * shows an ellipsis when not focused. Uses the grid "mirror" trick: an
 * invisible copy of the value sizes the cell the input fills.
 */
export function CtAutoWidthInput({
  value,
  onChange,
  onCommit,
  maxWidth,
  minWidth = 48,
  className,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Enter / blur. */
  onCommit?: (v: string) => void;
  maxWidth: number;
  minWidth?: number;
  className?: string;
  placeholder?: string;
}) {
  return (
    <span className="inline-grid min-w-0 items-center" style={{ maxWidth, minWidth }}>
      <span aria-hidden className={cx("invisible col-start-1 row-start-1 overflow-hidden whitespace-pre px-2", className)}>
        {(value || placeholder || " ") + "  "}
      </span>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => onCommit?.(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className={cx(
          "col-start-1 row-start-1 h-8 w-full min-w-0 truncate rounded-md border border-transparent bg-transparent px-2 outline-none",
          "hover:border-input focus:border-input focus:ring-2 focus:ring-sky-500/60",
          className,
        )}
      />
    </span>
  );
}

/**
 * Labelled field. A <div>, not a <label>: a wrapping label re-dispatches clicks
 * to the first control inside, which re-toggles Radix triggers.
 */
type Named = { "aria-label"?: string; ariaLabel?: string };
/** Give a lone CtInput / CtTextarea / CtSelect / input its field name; a wrapper div (several boxes) is left alone. */
function nameField(children: React.ReactNode, label: string): React.ReactNode {
  if (!React.isValidElement<Named>(children)) return children;
  const t = children.type;
  if (typeof t === "string" && !["input", "textarea", "select"].includes(t)) return children;
  if (children.props["aria-label"] || children.props.ariaLabel) return children;
  return React.cloneElement(children, t === CtSelect ? { ariaLabel: label } : { "aria-label": label });
}

export function CtField({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="block space-y-1">
      <span className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      {/* A lone input/select gets the field name for screen readers (the label above is a plain span). */}
      {nameField(children, label)}
      {hint && <span className="block text-xs leading-snug text-muted-foreground">{hint}</span>}
    </div>
  );
}

/**
 * Number input typed freely (asked 2026-10-29): a plain text box, no spinner — what is typed stays as typed and is
 * committed on blur / Enter (Escape = back to the value). Committing every keystroke broke typing: callers clamp
 * (Math.max(5, v)), so the "1" of "120" came back as 5 and replaced the draft. "," counts as a decimal point.
 * min / max clamp the committed number; step is kept for callers (no spinner any more).
 */
export function CtNumber({
  value,
  onChange,
  min,
  max,
  className,
  "aria-label": ariaLabel,
}: {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  className?: string;
  "aria-label"?: string;
}) {
  const [draft, setDraft] = React.useState(String(round(value)));
  const [editing, setEditing] = React.useState(false);
  const cancelled = React.useRef(false);
  // Follow outside changes during render, not in an effect: dragging a zone changes these values every
  // frame, and a setState-in-effect per field per frame tripped React's "Maximum update depth exceeded".
  // Never while the box is being typed in.
  if (!editing && draft !== String(round(value))) setDraft(String(round(value)));
  const commit = () => {
    setEditing(false);
    if (cancelled.current) {
      cancelled.current = false;
      return setDraft(String(round(value)));
    }
    const n = parseNumber(draft);
    if (n === null) return setDraft(String(round(value)));
    const v = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
    if (v !== value) onChange(v);
    setDraft(String(round(v)));
  };
  return (
    <CtInput
      type="text"
      inputMode="decimal"
      autoComplete="off"
      className={className}
      aria-label={ariaLabel}
      value={draft}
      onFocus={(e) => {
        setEditing(true);
        e.currentTarget.select();
      }}
      onChange={(e) => {
        setEditing(true);
        setDraft(e.target.value);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          cancelled.current = true;
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/** A typed number ("12", "-3.5", "53,1", " 7 "), null when it is not one. */
function parseNumber(text: string): number | null {
  const t = text.trim().replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** shadcn Checkbox with a label and an optional explanation underneath. */
export function CtCheckbox({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  const id = React.useId();
  return (
    <div className={cx("flex items-start gap-2", disabled && "opacity-60")}>
      <CheckboxPrimitive.Root
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onChange(v === true)}
        className="group -mx-1 -mb-1 -mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60"
      >
        {/* 24px hit area around the 16px box (WCAG 2.5.8); negative margins keep the box where it was. */}
        <span
          className={cx(
            "flex h-4 w-4 items-center justify-center rounded-[4px] border border-input shadow-sm",
            "group-data-[state=checked]:border-sky-500 group-data-[state=checked]:bg-sky-500 group-data-[state=checked]:text-white",
          )}
        >
          <CheckboxPrimitive.Indicator>
            <Check className="h-3 w-3" strokeWidth={3} />
          </CheckboxPrimitive.Indicator>
        </span>
      </CheckboxPrimitive.Root>
      <label htmlFor={id} className="cursor-pointer select-none text-sm leading-tight">
        {label}
        {hint && <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{hint}</span>}
      </label>
    </div>
  );
}

export function CtModal({
  open,
  onOpenChange,
  title,
  children,
  wide,
  full,
  keepOpenOnOutside = true,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  children: React.ReactNode;
  wide?: boolean;
  /** Fills the window (a workspace, e.g. the AI photo studio). */
  full?: boolean;
  /**
   * Default true: only the close button / X / Esc close it (through onOpenChange) — a click, a focus move
   * or the end of a drag outside the panel never does, so work in a dialog is not lost by a stray click.
   */
  keepOpenOnOutside?: boolean;
}) {
  const stay = (e: Event) => {
    if (keepOpenOnOutside) e.preventDefault();
  };
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <DialogPrimitive.Content
          className={cx(
            "fixed z-50 rounded-xl border bg-background p-5 shadow-2xl",
            full
              ? "inset-3 flex flex-col overflow-hidden"
              : cx("left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 max-h-[90vh] overflow-y-auto", wide ? "w-[min(1100px,95vw)]" : "w-[min(560px,95vw)]"),
          )}
          onPointerDownOutside={stay}
          onInteractOutside={stay}
          onFocusOutside={stay}
        >
          <div className="mb-4 flex items-center justify-between">
            <DialogPrimitive.Title className="text-base font-semibold">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close className="rounded p-1 hover:bg-accent" aria-label="Đóng">
              <X className="h-4 w-4" />
            </DialogPrimitive.Close>
          </div>
          <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * Full-screen picture viewer (asked 2026-11-18: click a mockup to zoom it). Shows `images[index]` fitted to the window;
 * ← → (buttons or keys) step through the list, Esc / the X / a click on the dark backdrop closes it.
 * Zoom (asked 2026-11-18): mouse wheel zooms in/out around the pointer (1×–8×), drag pans a zoomed picture,
 * double-click toggles fitted ↔ 2.5× at the pointer; + / - / 0 keys too.
 */
export function CtLightbox({
  images,
  index,
  onIndex,
}: {
  images: Array<{ url: string; name?: string }>;
  /** null = closed. */
  index: number | null;
  onIndex: (i: number | null) => void;
}) {
  /** Scale + offset (px) of the picture from its fitted, centred place. */
  const [view, setView] = React.useState({ s: 1, x: 0, y: 0 });
  const reset = React.useCallback(() => setView({ s: 1, x: 0, y: 0 }), []);
  const [box, setBox] = React.useState<HTMLDivElement | null>(null);
  const drag = React.useRef<{ px: number; py: number; x: number; y: number; moved: boolean } | null>(null);
  /** A drag just ended — the click that follows it must not close the viewer. */
  const dragged = React.useRef(false);
  const [panning, setPanning] = React.useState(false);
  const open = index !== null && index >= 0 && index < images.length;
  const n = images.length;
  const step = React.useCallback(
    (d: number) => {
      if (index === null || n < 2) return;
      reset();
      onIndex((index + d + n) % n);
    },
    [index, n, onIndex, reset],
  );
  /** Zoom by factor `f`, keeping the point (cx, cy) — relative to the box centre — still under the pointer. */
  const zoomBy = React.useCallback((f: number, cx: number, cy: number) => {
    setView((v) => {
      const s = Math.min(8, Math.max(1, v.s * f));
      if (s === 1) return { s: 1, x: 0, y: 0 };
      const k = s / v.s;
      return { s, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });
  }, []);
  React.useEffect(() => {
    if (!box) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = box.getBoundingClientRect();
      zoomBy(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)), e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => box.removeEventListener("wheel", onWheel);
  }, [box, zoomBy]);
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
      else if (e.key === "+" || e.key === "=") zoomBy(1.25, 0, 0);
      else if (e.key === "-") zoomBy(0.8, 0, 0);
      else if (e.key === "0") reset();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, step, zoomBy, reset]);
  const img = open ? images[index!] : null;
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          reset();
          onIndex(null);
        }
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-black/85" />
        <DialogPrimitive.Content
          className="fixed inset-0 z-[60] flex flex-col outline-none"
          onClick={(e) => {
            if (e.target === e.currentTarget) onIndex(null);
          }}
        >
          <DialogPrimitive.Title className="sr-only">{img?.name || "Ảnh"}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">Xem ảnh phóng to</DialogPrimitive.Description>
          <div className="flex shrink-0 items-center gap-3 px-4 py-2 text-sm text-white">
            <span className="truncate">{img?.name}</span>
            {n > 1 && <span className="shrink-0 text-white/70">{(index ?? 0) + 1} / {n}</span>}
            {img && (
              <a href={img.url} target="_blank" rel="noreferrer" className="ml-auto flex shrink-0 items-center gap-1 rounded px-2 py-1 hover:bg-white/15" title="Mở ảnh gốc ở tab mới">
                <ExternalLink className="h-4 w-4" /> Ảnh gốc
              </a>
            )}
            <DialogPrimitive.Close className={cx("shrink-0 rounded p-1.5 hover:bg-white/15", !img && "ml-auto")} aria-label="Đóng">
              <X className="h-5 w-5" />
            </DialogPrimitive.Close>
          </div>
          <div
            ref={setBox}
            className="relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden p-4"
            onClick={(e) => {
              if (dragged.current) {
                dragged.current = false;
                return;
              }
              if (e.target === e.currentTarget) onIndex(null);
            }}
            onPointerDown={(e) => {
              if (view.s === 1 || e.button !== 0) return;
              drag.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y, moved: false };
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              const dx = e.clientX - d.px;
              const dy = e.clientY - d.py;
              if (!d.moved && Math.abs(dx) + Math.abs(dy) > 3) {
                d.moved = true;
                setPanning(true);
                // Capture only once it is a real drag: captured from the start, a plain click would land on the
                // backdrop and close the viewer.
                e.currentTarget.setPointerCapture(e.pointerId);
              }
              setView((v) => ({ ...v, x: d.x + dx, y: d.y + dy }));
            }}
            onPointerUp={() => {
              if (drag.current?.moved) dragged.current = true;
              drag.current = null;
              setPanning(false);
            }}
            onDoubleClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              if (view.s > 1) reset();
              else zoomBy(2.5, e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
            }}
          >
            {img && (
              // eslint-disable-next-line @next/next/no-img-element -- any picture URL
              <img
                key={img.url}
                src={img.url}
                alt={img.name || ""}
                draggable={false}
                style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`, transition: panning ? "none" : "transform 80ms ease-out" }}
                className={cx("max-h-full max-w-full select-none bg-white object-contain shadow-2xl", view.s > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in")}
              />
            )}
            {view.s > 1 && (
              <span className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded bg-black/70 px-2 py-0.5 text-xs text-white">
                {Math.round(view.s * 100)}% · nhấp đúp để thu về
              </span>
            )}
          </div>
          {n > 1 && (
            <>
              <button className={cx("absolute left-3 top-1/2 -translate-y-1/2 p-2", FLOAT_BTN)} onClick={() => step(-1)} aria-label="Ảnh trước">
                <ChevronLeft className="h-6 w-6" />
              </button>
              <button className={cx("absolute right-3 top-1/2 -translate-y-1/2 p-2", FLOAT_BTN)} onClick={() => step(1)} aria-label="Ảnh sau">
                <ChevronRight className="h-6 w-6" />
              </button>
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** A round action button floating on a picture (pencil on a clipart, ← → on a photo): coloured with a dark shadow so
 * it shows on any picture — dark ones disappeared on dark hair / the checker (asked 2026-10-13). */
export const FLOAT_BTN = "rounded-full bg-orange-500 text-white ring-1 ring-black/30 shadow-[0_2px_8px_rgba(0,0,0,0.75)] hover:bg-orange-600";

/** Checkerboard backdrop so transparency is visible. */
export const CHECKER_STYLE: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(45deg,#8883 25%,transparent 25%),linear-gradient(-45deg,#8883 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#8883 75%),linear-gradient(-45deg,transparent 75%,#8883 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0,0 8px,8px -8px,-8px 0",
};
