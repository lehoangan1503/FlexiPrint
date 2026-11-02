"use client";

/**
 * A row of filter buttons ("Tất cả · Đã deploy · Chưa deploy", "Bộ kiểu 1/2/3") — one of them on. A new filter is one
 * more entry in `options`.
 */

import { cx } from "./ui";

export interface CtFilterOption<T extends string | number> {
  value: T;
  label: string;
  title?: string;
}

export function FilterChips<T extends string | number>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: Array<CtFilterOption<T>> }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          onClick={() => onChange(o.value)}
          title={o.title}
          className={cx("h-8 rounded-full border px-3 text-xs font-medium", value === o.value ? "border-foreground bg-foreground text-background" : "hover:bg-accent")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
