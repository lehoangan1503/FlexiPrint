"use client";

import { useState, useTransition } from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, Loader2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { setUserRole } from "./actions";
import type { UserRole } from "@/types/auth";

interface RoleSelectProps {
  userId: string;
  role: UserRole;
}

// Radix Select cannot use null/"" as an item value, so a normal user is
// represented by this sentinel in the UI only.
const NORMAL = "normal";

type RoleValue = typeof NORMAL | "mode" | "admin";

const ROLE_OPTIONS: Array<{ value: RoleValue; label: string; hint: string }> = [
  { value: NORMAL, label: "Người dùng", hint: "Tạo & sửa sản phẩm của mình" },
  { value: "mode", label: "Mode", hint: "Như người dùng (dành cho vai trò mở rộng sau)" },
  { value: "admin", label: "Admin", hint: "Quản lý thư viện AI style chung" },
];

function toValue(role: UserRole): RoleValue {
  return role ?? NORMAL;
}

function toRole(value: RoleValue): UserRole {
  return value === NORMAL ? null : value;
}

export function RoleSelect({ userId, role }: RoleSelectProps) {
  const [value, setValue] = useState<RoleValue>(toValue(role));
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleChange(next: string) {
    const nextValue = next as RoleValue;
    const previous = value;
    setError(null);
    // Optimistic: revert if the server rejects.
    setValue(nextValue);

    startTransition(async () => {
      try {
        const result = await setUserRole(userId, toRole(nextValue));
        if (result?.error) {
          setValue(previous);
          setError(result.error);
        }
      } catch (e) {
        setValue(previous);
        setError(e instanceof Error ? e.message : "Lỗi không xác định");
      }
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Select value={value} onValueChange={handleChange} disabled={pending}>
          <SelectTrigger className="h-8 w-[140px] shrink-0 text-xs [&>span]:truncate">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-w-[260px]">
            {/* Radix mirrors ONLY ItemText into the trigger. The hint sits
                outside it, so it shows in the dropdown list but never overflows
                the fixed-height trigger. This is why the shared SelectItem
                isn't used here — it wraps all children in ItemText. */}
            {ROLE_OPTIONS.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                className="relative flex w-full cursor-pointer select-none flex-col items-start gap-0.5 rounded-md py-2 pl-3 pr-8 text-xs outline-none transition-colors focus:bg-accent focus:text-accent-foreground dark:focus:bg-white/10 dark:focus:text-white data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
              >
                <span className="absolute right-2 top-2.5 flex h-4 w-4 items-center justify-center">
                  <SelectPrimitive.ItemIndicator>
                    <Check className="h-4 w-4 text-primary dark:text-white" />
                  </SelectPrimitive.ItemIndicator>
                </span>
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                <span className="text-[10px] leading-snug text-muted-foreground">
                  {option.hint}
                </span>
              </SelectPrimitive.Item>
            ))}
          </SelectContent>
        </Select>
        {pending && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        {/* A dot, not a repeated label — the trigger already names the role. */}
        {!pending && value === "admin" && (
          <span className="h-2 w-2 shrink-0 rounded-full bg-sky-500" title="Admin" />
        )}
        {!pending && value === "mode" && (
          <span className="h-2 w-2 shrink-0 rounded-full bg-green-500" title="Mode" />
        )}
      </div>
      {error && (
        <span className="text-xs text-destructive max-w-[260px] break-words">{error}</span>
      )}
    </div>
  );
}
