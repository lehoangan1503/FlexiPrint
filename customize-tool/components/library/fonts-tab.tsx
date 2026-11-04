"use client";

/**
 * Thư viện → Font chữ (asked 2026-11-04): the team's own fonts, uploaded once and offered in every text layer's font
 * list (server/fonts.ts). Each card writes a sample in its font; the uploader or an admin removes it — text layers
 * already using it keep drawing it.
 */

import { useEffect, useRef, useState } from "react";
import { Loader2, Trash2, Upload } from "lucide-react";
import { CT_FONTS, ctGoogleFontsHref } from "../../config";
import type { CtLibraryFont } from "../../types";
import { ctApi } from "../../lib/api-client";
import { reloadFonts, useLibraryFonts } from "../font-library";
import { CtButton, CtInput } from "../ui";
import { ctConfirm } from "../dialogs";

export function FontsTab({ currentUserId, admin }: { currentUserId: string; admin: boolean }) {
  const fonts = useLibraryFonts();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [sample, setSample] = useState("Merry Christmas 2026");
  const fileRef = useRef<HTMLInputElement | null>(null);
  // The tool's Google fonts, for their samples (the editor adds the same stylesheet).
  useEffect(() => {
    const id = "ct-google-fonts";
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = ctGoogleFontsHref();
    document.head.appendChild(link);
  }, []);

  const upload = async (files: FileList) => {
    setBusy(true);
    setError(null);
    setNote(null);
    const added: string[] = [];
    const failed: string[] = [];
    for (const f of Array.from(files)) {
      try {
        const font = await ctApi.uploadFont(f);
        added.push(font.name);
      } catch (e) {
        failed.push(`${f.name}: ${e instanceof Error ? e.message : "lỗi"}`);
      }
    }
    await reloadFonts();
    setBusy(false);
    if (added.length) setNote(`Đã thêm ${added.length} font: ${added.join(", ")}`);
    if (failed.length) setError(failed.join(" · "));
  };

  const remove = async (f: CtLibraryFont) => {
    if (!(await ctConfirm({ title: `Xoá font “${f.name}”?`, message: "Font không còn trong danh sách chọn. Layer chữ đang dùng font này vẫn vẽ đúng.", tone: "danger", confirmLabel: "Xoá" }))) return;
    try {
      await ctApi.deleteFont(f.id);
      await reloadFonts();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Xoá thất bại");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={fileRef}
          type="file"
          multiple
          accept=".ttf,.otf,.woff,font/ttf,font/otf,font/woff"
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) void upload(e.target.files);
            e.target.value = "";
          }}
        />
        <CtButton variant="primary" onClick={() => fileRef.current?.click()} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Tải font lên
        </CtButton>
        <span className="text-xs text-muted-foreground">.ttf · .otf · .woff — dùng chung cho mọi sản phẩm, chọn trong ô Font của layer chữ.</span>
        <CtInput className="ml-auto h-9 w-64" value={sample} onChange={(e) => setSample(e.target.value)} placeholder="Chữ mẫu" />
      </div>
      {note && <p className="rounded-md bg-emerald-500/10 p-2 text-sm text-emerald-700 dark:text-emerald-400">{note}</p>}
      {error && <p className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">{error}</p>}

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Font đã tải lên ({fonts.length})</h3>
        {fonts.length === 0 ? (
          <div className="rounded-xl border border-dashed py-14 text-center text-sm text-muted-foreground">Chưa có font nào — bấm “Tải font lên”.</div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {fonts.map((f) => (
              <div key={f.id} className="group relative rounded-xl border bg-card p-3">
                <div className="truncate text-2xl leading-tight" style={{ fontFamily: `"${f.family}", sans-serif` }} title={sample}>
                  {sample || f.name}
                </div>
                <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="truncate font-medium text-foreground">{f.name}</span>
                  <span className="rounded bg-muted px-1 uppercase">{f.format}</span>
                  <span className="ml-auto">{new Date(f.created_at).toLocaleDateString("vi-VN")}</span>
                </div>
                {(admin || f.user_id === currentUserId) && (
                  <button className="absolute right-2 top-2 rounded p-1 text-destructive opacity-0 hover:bg-accent group-hover:opacity-100" onClick={() => void remove(f)} title="Xoá font">
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Font có sẵn (Google Fonts)</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {CT_FONTS.map((f) => (
            <div key={f.family} className="rounded-xl border p-3">
              <div className="truncate text-2xl leading-tight" style={{ fontFamily: `"${f.family}", sans-serif` }}>
                {sample || f.label}
              </div>
              <div className="mt-2 text-[11px] text-muted-foreground">{f.label}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
