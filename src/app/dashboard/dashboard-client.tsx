"use client";

import { useEffect, useState } from "react";
import { Printer } from "lucide-react";
import type { UserProfile } from "@/types/auth";
import { UserDropdown } from "@/components/user-dropdown";
import { FirstLoginDialog } from "@/components/first-login-dialog";
import { ThemeToggle } from "@/components/theme-toggle";
import { CustomizeProductList } from "../../../customize-tool/components/product-list";
import { ImportStatus } from "../../../customize-tool/components/char/import-status";
import { LibraryTab } from "../../../customize-tool/components/library/library-tab";

/** The dashboard's two tabs (asked 2026-11-03): the finished products, and the library they are made from (clipart
 * sets, phôi, khuôn in). The tab is in the address (?tab=library). */
type DashboardTab = "products" | "library";
const TABS: Array<[DashboardTab, string]> = [
  ["products", "Sản phẩm"],
  ["library", "Thư viện"],
];
export function DashboardClient({ profile, isSuperAdmin }: { profile: UserProfile; isSuperAdmin: boolean }) {
  const [askNickname, setAskNickname] = useState(!profile.nickname);
  const [current, setCurrent] = useState(profile);
  const [tab, setTab] = useState<DashboardTab>("products");
  // After the first paint: the address is only known in the browser.
  useEffect(() => {
    const id = setTimeout(() => {
      if (new URLSearchParams(window.location.search).get("tab") === "library") setTab("library");
    }, 0);
    return () => clearTimeout(id);
  }, []);
  const pick = (t: DashboardTab) => {
    setTab(t);
    const url = new URL(window.location.href);
    url.search = t === "library" ? "?tab=library" : "";
    window.history.replaceState(null, "", url);
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b bg-card/80 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
          <Printer className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">FlexiPrint</h1>
          <div className="ml-auto flex items-center gap-2">
            <ImportStatus />
            <ThemeToggle />
            <UserDropdown key={current.nickname ?? ""} profile={current} isSuperAdmin={isSuperAdmin} />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <nav className="mb-6 flex gap-6 border-b">
          {TABS.map(([k, label]) => (
            <button
              key={k}
              onClick={() => pick(k)}
              className={`-mb-px border-b-2 pb-2.5 text-lg font-semibold ${tab === k ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            >
              {label}
            </button>
          ))}
        </nav>
        {tab === "products" ? (
          <CustomizeProductList currentUserId={profile.user_id} admin={isSuperAdmin || profile.role === "admin"} />
        ) : (
          <LibraryTab currentUserId={profile.user_id} admin={isSuperAdmin || profile.role === "admin"} />
        )}
      </main>
      <FirstLoginDialog
        open={askNickname}
        onComplete={(nickname) => {
          setAskNickname(false);
          if (nickname) setCurrent({ ...current, nickname });
        }}
      />
    </div>
  );
}
