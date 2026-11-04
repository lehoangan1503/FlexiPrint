"use client";

import { useEffect, useState } from "react";
import type { UserProfile } from "@/types/auth";
import { UserDropdown } from "@/components/user-dropdown";
import { FirstLoginDialog } from "@/components/first-login-dialog";
import { ThemeToggle } from "@/components/theme-toggle";
import { CustomizeProductList } from "../../../customize-tool/components/product-list";
import { ImportStatus } from "../../../customize-tool/components/char/import-status";
import { LibraryTab } from "../../../customize-tool/components/library/library-tab";
import { ArtworksTab } from "../../../customize-tool/components/library/artworks-tab";

/**
 * The dashboard's tabs (asked 2026-11-03, Artwork added 2026-11-04): Product (what is sold: photos, info, its
 * artworks) · Artwork (every product's artworks built on the phôi: preview + print file) · Thư viện (what products are
 * made from: clipart sets, template phôi, khuôn in, fonts). The tab is in the address (?tab=artwork&product=…).
 */
type DashboardTab = "products" | "artwork" | "library";
const TABS: Array<[DashboardTab, string]> = [
  ["products", "Product"],
  ["artwork", "Artwork"],
  ["library", "Thư viện"],
];
const isTab = (v: string | null): v is DashboardTab => TABS.some(([k]) => k === v);

export function DashboardClient({ profile, isSuperAdmin }: { profile: UserProfile; isSuperAdmin: boolean }) {
  const [askNickname, setAskNickname] = useState(!profile.nickname);
  const [current, setCurrent] = useState(profile);
  const [tab, setTab] = useState<DashboardTab>("products");
  /** The Artwork tab narrowed to one product (its card's "Artwork" link). */
  const [artworkProduct, setArtworkProduct] = useState<string | null>(null);
  // After the first paint: the address is only known in the browser.
  useEffect(() => {
    const id = setTimeout(() => {
      const q = new URLSearchParams(window.location.search);
      const t = q.get("tab");
      if (isTab(t)) setTab(t);
      setArtworkProduct(q.get("product"));
    }, 0);
    return () => clearTimeout(id);
  }, []);
  const pick = (t: DashboardTab, product: string | null = null) => {
    setTab(t);
    setArtworkProduct(product);
    const url = new URL(window.location.href);
    url.search = t === "products" ? "" : `?tab=${t}${product ? `&product=${product}` : ""}`;
    window.history.replaceState(null, "", url);
  };
  const admin = isSuperAdmin || profile.role === "admin";

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b bg-card/80 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="" className="h-7 w-7" />
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
          <CustomizeProductList currentUserId={profile.user_id} admin={admin} onShowArtworks={(id) => pick("artwork", id)} />
        ) : tab === "artwork" ? (
          <ArtworksTab key={artworkProduct ?? "all"} productId={artworkProduct} onClearProduct={() => pick("artwork")} />
        ) : (
          <LibraryTab currentUserId={profile.user_id} admin={admin} />
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
