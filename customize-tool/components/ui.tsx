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
import { Check, ChevronDown, X } from "lucide-react";
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
  sm: "h-8 px-2.5 text-xs gap-1.5",
  md: "h-9 px-3.5 text-sm gap-2",
  icon: "h-8 w-8 justify-center",
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
        "h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm outline-none focus:ring-2 focus:ring-sky-500/60",
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
          "w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-sky-500/60",
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
}

/** shadcn Select. Radix forbids "" as an item value, so an empty value shows the placeholder. */
export function CtSelect<T extends string>({
  value,
  onChange,
  options,
  className,
  placeholder = "Chọn…",
  disabled,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<CtSelectOption<T>>;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const known = options.some((o) => o.value === value);
  return (
    <SelectPrimitive.Root value={known ? value : undefined} onValueChange={(v) => onChange(v as T)} disabled={disabled}>
      <SelectPrimitive.Trigger
        className={cx(
          "flex h-8 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-2 text-sm",
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
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
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
export function CtField({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="block space-y-1">
      <span className="block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="block text-[11px] leading-snug text-muted-foreground">{hint}</span>}
    </div>
  );
}

/** Number input that commits on every valid keystroke. */
export function CtNumber({
  value,
  onChange,
  step = 1,
  min,
  max,
  className,
}: {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  className?: string;
}) {
  const [draft, setDraft] = React.useState(String(round(value)));
  // Follow outside changes during render, not in an effect: dragging a zone changes these values every
  // frame, and a setState-in-effect per field per frame tripped React's "Maximum update depth exceeded".
  const [shown, setShown] = React.useState(value);
  if (shown !== value) {
    setShown(value);
    if (Number(draft) !== value) setDraft(String(round(value)));
  }
  return (
    <CtInput
      type="number"
      className={className}
      value={draft}
      step={step}
      min={min}
      max={max}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value !== "" && Number.isFinite(n)) onChange(n);
      }}
    />
  );
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
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  const id = React.useId();
  return (
    <div className="flex items-start gap-2">
      <CheckboxPrimitive.Root
        id={id}
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
        className={cx(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border border-input shadow-sm",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60",
          "data-[state=checked]:border-sky-500 data-[state=checked]:bg-sky-500 data-[state=checked]:text-white",
        )}
      >
        <CheckboxPrimitive.Indicator>
          <Check className="h-3 w-3" strokeWidth={3} />
        </CheckboxPrimitive.Indicator>
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
