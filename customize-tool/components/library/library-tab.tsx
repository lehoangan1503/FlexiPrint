"use client";

/**
 * /dashboard → Thư viện (asked 2026-11-03): everything a product is made from, one tab of the dashboard next to the
 * products (the old /v2 list and /library page folded in here):
 *
 *   Clipart   the clipart sets (bộ nhân vật / bộ ảnh khách / imports) as cards — two option pictures + "…" so a set
 *             does not look like a product — searched and filtered by kind (lib/set-kind.ts). A card opens the set's
 *             clipart (CharSetFiles) here; a set not drawn yet opens its own page (/v2/:id).
 *   Font chữ  the team's fonts.
 * Khuôn in + phôi moved to the Product base tab (2026-11-07): each base product owns the khuôn + phôi of its piece.
 *
 * "Import bộ clipart" and "Tạo bộ clipart mới" sit on top. The sub-tab and the open set are in the address
 * (?lib=…&set=…) so a reload or a link opens them again.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, MoreHorizontal, Plus, Search, Sparkles, Trash2 } from "lucide-react";
import type { CtCharProject } from "../../types";
import { charApi } from "../../lib/api-client";
import { defaultCharBrief } from "../../lib/char-brief";
import { SET_KIND_INFO, SET_KINDS, setKind, type CtSetKind } from "../../lib/set-kind";
import { CHECKER_STYLE, CtButton, CtInput, CtTooltipProvider, cx } from "../ui";
import { ctConfirm, ctPrompt } from "../dialogs";
import { CharSetFiles } from "../char/set-files";
import { KindHelpButton } from "../char/kind-help";
import { ImportButton } from "../char/import-button";
import { FilterChips } from "../filter-chips";
import { FontsTab } from "./fonts-tab";

export type CtLibraryTab = "clipart" | "fonts";

const TABS: Array<[CtLibraryTab, string]> = [
  ["clipart", "Clipart"],
  ["fonts", "Font chữ"],
];

function setParam(key: string, value: string | null) {
  const url = new URL(window.location.href);
  if (value) url.searchParams.set(key, value);
  else url.searchParams.delete(key);
  window.history.replaceState(null, "", url);
}

export function LibraryTab({ currentUserId, admin }: { currentUserId: string; admin: boolean }) {
  const router = useRouter();
  const [tab, setTab] = useState<CtLibraryTab>("clipart");
  const [openSet, setOpenSet] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // After the first paint: the address is only known in the browser.
  useEffect(() => {
    const id = setTimeout(() => {
      const q = new URLSearchParams(window.location.search);
      const t = q.get("lib");
      if (t && TABS.some(([k]) => k === t)) setTab(t as CtLibraryTab);
      setOpenSet(q.get("set"));
    }, 0);
    return () => clearTimeout(id);
  }, []);

  const pick = (t: CtLibraryTab) => {
    setTab(t);
    setOpenSet(null);
    setParam("lib", t);
    setParam("set", null);
  };
  const openOne = (id: string | null) => {
    setOpenSet(id);
    setParam("set", id);
  };

  /** One "Tạo bộ clipart mới": the kind is picked in the set's brief. */
  const create = async () => {
    const name = await ctPrompt({ title: "Tạo bộ clipart mới", label: "Tên bộ", defaultValue: "Ornament tốt nghiệp — nam / nữ", confirmLabel: "Tạo" });
    if (!name?.trim()) return;
    setCreating(true);
    try {
      const p = await charApi.create({ name: name.trim(), brief: defaultCharBrief("character") });
      router.push(`/v2/${p.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tạo được");
      setCreating(false);
    }
  };

  return (
    <CtTooltipProvider>
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex rounded-md border p-0.5">
            {TABS.map(([k, label]) => (
              <button key={k} onClick={() => pick(k)} className={cx("rounded px-3 py-1 text-sm font-medium", tab === k ? "bg-foreground text-background" : "hover:bg-accent")}>
                {label}
              </button>
            ))}
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <KindHelpButton />
            <ImportButton />
            <CtButton variant="primary" onClick={() => void create()} disabled={creating}>
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Tạo bộ clipart mới
            </CtButton>
          </div>
        </div>
        {error && <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
        {tab === "fonts" ? (
          <FontsTab currentUserId={currentUserId} admin={admin} />
        ) : openSet ? (
          <div className="space-y-3">
            <button onClick={() => openOne(null)} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-4 w-4" /> Các bộ clipart
            </button>
            <CharSetFiles key={openSet} projectId={openSet} currentUserId={currentUserId} admin={admin} />
          </div>
        ) : (
          <SetGrid currentUserId={currentUserId} admin={admin} onOpen={openOne} onError={setError} />
        )}
      </div>
    </CtTooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// Clipart sets
// ---------------------------------------------------------------------------

type KindFilter = "all" | CtSetKind;

/**
 * Bộ = a whole set (drawn, imported) · Cụm = layers picked in a product and saved together (asked 2026-11-04: one
 * character with every hair / outfit of his pose, to reuse beside something else). Clipart cannot be kept one by one:
 * a cut file only fits the doll it was cut on, so the smallest reusable piece is such a cụm.
 */
type GroupFilter = "all" | "set" | "cum";
const isCum = (p: CtCharProject) => !!p.brief.extracted;

function SetGrid({ currentUserId, admin, onOpen, onError }: { currentUserId: string; admin: boolean; onOpen: (id: string) => void; onError: (e: string) => void }) {
  const [projects, setProjects] = useState<CtCharProject[] | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [options, setOptions] = useState<Record<string, string[]>>({});
  const [q, setQ] = useState("");
  const [kind, setKindFilter] = useState<KindFilter>("all");
  const [group, setGroup] = useState<GroupFilter>("all");

  const load = useCallback(async () => {
    try {
      const r = await charApi.list();
      setProjects(r.projects);
      setThumbs(r.thumbs);
      setOptions(r.options ?? {});
    } catch (e) {
      onError(e instanceof Error ? e.message : "Không tải được");
      setProjects([]);
    }
  }, [onError]);
  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  const shown = useMemo(() => {
    const words = q.trim().toLowerCase();
    return (projects ?? []).filter(
      (p) => (group === "all" || (group === "cum") === isCum(p)) && (kind === "all" || setKind(p) === kind) && (!words || p.name.toLowerCase().includes(words)),
    );
  }, [projects, q, kind, group]);

  const remove = async (p: CtCharProject) => {
    if (!(await ctConfirm({ title: `Xoá “${p.name}”?`, message: "Xoá brief, master, ảnh cắt clipart và layer của bộ. Sản phẩm đã tạo từ bộ vẫn giữ.", tone: "danger", confirmLabel: "Xoá" }))) return;
    try {
      await charApi.remove(p.id);
      setProjects((list) => (list ?? []).filter((x) => x.id !== p.id));
    } catch (e) {
      onError(e instanceof Error ? e.message : "Xoá thất bại");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <FilterChips<GroupFilter>
          value={group}
          onChange={setGroup}
          options={[
            { value: "all", label: "Tất cả" },
            { value: "set", label: "Bộ clipart", title: "Bộ đầy đủ: người + tóc, quần áo, mắt… đúng vị trí, không nền" },
            { value: "cum", label: `Cụm clipart (${(projects ?? []).filter(isCum).length})`, title: "Các layer chọn trong 1 sản phẩm rồi “Lưu thành bộ clipart” (một nhân vật với mọi kiểu tóc / quần áo đúng dáng)" },
          ]}
        />
        <span className="h-5 w-px bg-border" />
        <FilterChips<KindFilter>
          value={kind}
          onChange={setKindFilter}
          options={[{ value: "all", label: "Tất cả" }, ...SET_KINDS.map((k) => ({ value: k as KindFilter, label: `Bộ ${SET_KIND_INFO[k].label.toLowerCase()}`, title: SET_KIND_INFO[k].short }))]}
        />
        <div className="relative ml-auto">
          <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <CtInput className="h-9 w-56 pl-8" placeholder="Tìm bộ clipart…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {projects === null ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : shown.length === 0 ? (
        <div className="rounded-xl border border-dashed py-20 text-center text-sm text-muted-foreground">
          <Sparkles className="mx-auto mb-3 h-10 w-10 opacity-40" />
          {projects.length ? "Không có bộ nào khớp." : "Chưa có bộ clipart nào."}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {shown.map((p) => (
            <SetCard
              key={p.id}
              project={p}
              thumb={thumbs[p.id]}
              options={options[p.id] ?? []}
              mine={admin || p.user_id === currentUserId}
              onOpen={() => onOpen(p.id)}
              onRemove={() => void remove(p)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SetCard({ project: p, thumb, options, mine, onOpen, onRemove }: { project: CtCharProject; thumb?: string; options: string[]; mine: boolean; onOpen: () => void; onRemove: () => void }) {
  // A set with clipart opens here; one still being drawn (no product yet) opens its own page.
  const ready = p.product_ids.length > 0;
  const k = setKind(p);
  const body = (
    <>
      <div className="relative aspect-square" style={CHECKER_STYLE}>
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element -- our R2 WebP preview
          <img src={thumb} alt={p.name} className="h-full w-full object-contain p-2" loading="lazy" />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Chưa có ảnh</div>
        )}
        {/* Two of its options + "…": a clipart set, not a product. */}
        {options.length > 0 && (
          <div className="absolute bottom-2 left-2 flex gap-1.5">
            {options.map((src) => (
              <span key={src} className="h-11 w-11 overflow-hidden rounded-md border-2 border-background bg-white shadow">
                {/* eslint-disable-next-line @next/next/no-img-element -- option thumbnail */}
                <img src={src} alt="" className="h-full w-full object-contain" loading="lazy" />
              </span>
            ))}
            <span className="flex h-11 w-11 items-center justify-center rounded-md border-2 border-background bg-muted text-muted-foreground shadow">
              <MoreHorizontal className="h-5 w-5" />
            </span>
          </div>
        )}
      </div>
      <div className="p-2.5">
        <div className="truncate text-sm font-medium">{p.name}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px]">
          <span className="rounded bg-orange-500/15 px-1.5 py-0.5 font-medium text-orange-600" title={SET_KIND_INFO[k].short}>
            {SET_KIND_INFO[k].label}
          </span>
          {isCum(p) && <span className="rounded bg-sky-500/15 px-1.5 py-0.5 font-medium text-sky-600" title={`Tách từ “${p.brief.extracted?.productName ?? ""}”`}>Cụm</span>}
          {!ready && <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">Đang làm</span>}
          <span className="text-muted-foreground">{new Date(p.updated_at).toLocaleDateString("vi-VN")}</span>
        </div>
      </div>
    </>
  );
  return (
    <div className="group relative overflow-hidden rounded-xl border bg-card hover:border-foreground/40">
      {ready ? (
        <button onClick={onOpen} className="block w-full text-left">
          {body}
        </button>
      ) : (
        <Link href={`/v2/${p.id}`} className="block">
          {body}
        </Link>
      )}
      {mine && (
        <button className="absolute right-2 top-2 rounded bg-background/80 p-1 text-destructive opacity-0 hover:bg-background group-hover:opacity-100" onClick={onRemove} title="Xoá">
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
