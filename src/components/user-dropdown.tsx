"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChevronDown, User, Check, Loader2, LogOut, Pencil, ShieldCheck } from "lucide-react";
import { logout } from "@/app/login/actions";
import type { UserProfile } from "@/types/auth";

interface UserDropdownProps {
  profile: UserProfile;
  /** Show the link to /admin (superadmin only). */
  isSuperAdmin?: boolean;
}

export function UserDropdown({ profile: initialProfile, isSuperAdmin = false }: UserDropdownProps) {
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState(initialProfile);
  const [nickname, setNickname] = useState(initialProfile.nickname ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [editing, setEditing] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const displayName = profile.nickname || profile.email;

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
        setEditing(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  async function handleSaveNickname() {
    if (saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname: nickname.trim() || null }),
      });
      if (!res.ok) throw new Error("Failed");
      const updated = await res.json();
      setProfile(updated);
      setNickname(updated.nickname ?? "");
      setSaved(true);
      setEditing(false);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      alert("Không thể lưu biệt danh");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 max-w-[180px]"
      >
        <User className="h-4 w-4 shrink-0" />
        <span className="truncate text-sm hidden sm:inline">{displayName}</span>
        <ChevronDown className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </Button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-72 rounded-lg border bg-card shadow-lg z-50 p-4 flex flex-col gap-3">
          {/* Email */}
          <div>
            <p className="text-xs text-muted-foreground mb-0.5">Email</p>
            <p className="text-sm font-medium break-all">{profile.email}</p>
          </div>

          <div className="h-px bg-border" />

          {/* Nickname */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground">Biệt danh</Label>
              {!editing && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => setEditing(true)}
                  title="Đổi biệt danh"
                >
                  <Pencil className="h-3 w-3" />
                </Button>
              )}
            </div>

            {editing ? (
              <div className="flex gap-2">
                <Input
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  placeholder="Nhập biệt danh..."
                  maxLength={50}
                  className="h-8 text-sm flex-1"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveNickname();
                    if (e.key === "Escape") { setEditing(false); setNickname(profile.nickname ?? ""); }
                  }}
                  autoFocus
                />
                <Button size="sm" className="h-8 px-3" onClick={handleSaveNickname} disabled={saving}>
                  {saving ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : saved ? (
                    <Check className="h-3 w-3" />
                  ) : (
                    "Lưu"
                  )}
                </Button>
              </div>
            ) : (
              <p className="text-sm">
                {profile.nickname ? (
                  <span className="font-medium">{profile.nickname}</span>
                ) : (
                  <span className="text-muted-foreground italic">Chưa có biệt danh</span>
                )}
              </p>
            )}
          </div>

          <div className="h-px bg-border" />

          {isSuperAdmin && (
            <Button variant="ghost" size="sm" className="justify-start -mx-1" asChild>
              <Link href="/admin/dashboard">
                <ShieldCheck className="h-4 w-4" />
                Admin dashboard
              </Link>
            </Button>
          )}
          <form action={logout}>
            <Button type="submit" variant="ghost" size="sm" className="w-full justify-start -mx-1">
              <LogOut className="h-4 w-4" />
              Đăng xuất
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
