"use client";

/**
 * /library — what products are made from. Since 2026-10-29 everything starts from a bộ nhân vật v2, so nothing is
 * uploaded or filed by hand here:
 *
 *   Clipart   the finished bộ nhân vật, one per row: a set's clipart are shown — and fixed by hand — as the set's own
 *             step 3c view (components/char/set-files.tsx). They fit only their set, so they are never listed alone.
 *   Phôi      blank product photos · Khuôn in  print templates.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2 } from "lucide-react";
import type { CtCharProject } from "../../types";
import { charApi } from "../../lib/api-client";
import { CtTooltipProvider, cx } from "../ui";
import { finishedSets } from "../editor/library-panel";
import { CharSetFiles } from "../char/set-files";
import { KhuonTab } from "../print/khuon-tab";
import { PhoiTab } from "../print/phoi-tab";

/** The library's sections: one place for everything a product is made from (asked 2026-10-10; Artwork dropped
 * 2026-10-29 — every design starts from a bộ nhân vật). */
export type CtLibraryTab = "clipart" | "phoi" | "khuon";

const TABS: Array<[CtLibraryTab, string]> = [
  ["clipart", "Clipart"],
  ["phoi", "Phôi"],
  ["khuon", "Khuôn in"],
];

export function LibraryManager({ initialTab = "clipart", currentUserId, admin }: { initialTab?: CtLibraryTab; currentUserId: string; admin: boolean }) {
  const [tab, setTab] = useState<CtLibraryTab>(initialTab);
  // The tab is in the address (?tab=…), so a link / a reload opens it again.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t && TABS.some(([k]) => k === t)) setTab(t as CtLibraryTab);
  }, []);
  const open = (t: CtLibraryTab) => {
    setTab(t);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", t);
    window.history.replaceState(null, "", url);
  };
  return (
    <CtTooltipProvider>
      <div className="flex h-screen flex-col bg-background text-foreground">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
          <Link href="/dashboard" className="rounded p-1.5 hover:bg-accent">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <h1 className="text-sm font-semibold">Thư viện</h1>
          <div className="ml-3 flex rounded-md border p-0.5">
            {TABS.map(([k, label]) => (
              <button key={k} onClick={() => open(k)} className={cx("rounded px-3 py-1 text-xs font-medium", tab === k ? "bg-foreground text-background" : "hover:bg-accent")}>
                {label}
              </button>
            ))}
          </div>
        </header>
        {tab === "khuon" ? <KhuonTab /> : tab === "phoi" ? <PhoiTab /> : <SetsTab currentUserId={currentUserId} admin={admin} />}
      </div>
    </CtTooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// Clipart = bộ nhân vật
// ---------------------------------------------------------------------------

function SetsTab({ currentUserId, admin }: { currentUserId: string; admin: boolean }) {
  const [sets, setSets] = useState<CtCharProject[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    charApi
      .list()
      .then((r) => {
        const list = finishedSets(r.projects);
        setSets(list);
        const asked = new URLSearchParams(window.location.search).get("set");
        setSelected((cur) => cur ?? (asked && list.some((p) => p.id === asked) ? asked : (list[0]?.id ?? null)));
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  const open = (id: string) => {
    setSelected(id);
    const url = new URL(window.location.href);
    url.searchParams.set("set", id);
    window.history.replaceState(null, "", url);
  };
  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-72 shrink-0 flex-col border-r">
        <div className="flex-1 overflow-y-auto p-1">
          {sets === null && !error && <Loader2 className="m-3 h-4 w-4 animate-spin" />}
          {error && <p className="p-2 text-xs text-destructive">{error}</p>}
          {sets?.length === 0 && <p className="p-3 text-xs text-muted-foreground">Chưa có bộ nhân vật hoàn chỉnh — làm bộ ở trang v2.</p>}
          {sets?.map((p) => (
            <div
              key={p.id}
              className={cx("flex cursor-pointer items-center gap-1 rounded px-2 py-1.5 text-sm", selected === p.id ? "bg-accent" : "hover:bg-accent/60")}
              onClick={() => open(p.id)}
              title={p.name}
            >
              <span className="flex-1 truncate">{p.name}</span>
              <span className="w-8 text-right text-[11px] text-muted-foreground">{p.layers?.slots.reduce((n, sl) => n + sl.files.length, 0) || ""}</span>
            </div>
          ))}
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto p-4">
        {selected ? <CharSetFiles key={selected} projectId={selected} currentUserId={currentUserId} admin={admin} /> : null}
      </main>
    </div>
  );
}
