"use client";

/**
 * Thư viện → Khuôn in (asked 2026-10-10). A khuôn is the piece, not a design: the sheet's size (width × height px,
 * dpi), what gets printed (safe zone), what doesn't (holes, unprinted parts) — a round ornament, a tile, a pair of
 * trousers alike. A garment is often made as ONE half (the other is its mirror image) and printed on several faces
 * (front / back). No shape editor and no AI here (removed 2026-10-10): a khuôn is one of the starting shapes
 * (lib/print-template.ts PRINT_PRESETS) or an uploaded picture; the editor changes its name, size, dpi, half-or-whole.
 */

import { useEffect, useRef, useState } from "react";
import { Loader2, Trash2, Upload } from "lucide-react";
import type { CtPrintFace, CtPrintSpec, CtPrintTemplate } from "../../types/print";
import { normalizePrintSpec } from "../../lib/print-template";
import { newId } from "../../lib/geometry";
import { printApi } from "../../lib/print-api";
import { ctConfirm } from "../dialogs";
import { CtButton, CtCheckbox, CtField, CtInput, CtModal, CtNumber, cx } from "../ui";
import { PrintSheet } from "./print-sheet";

const mmOf = (px: number, dpi: number) => Math.round((px / Math.max(1, dpi)) * 25.4 * 10) / 10;

/** A khuôn's sheet as a picture (its face, else the shapes it is drawn with). */
export function KhuonPreview({ spec, className }: { spec: CtPrintSpec; className?: string }) {
  return <PrintSheet spec={spec} className={className} />;
}

export function KhuonTab() {
  const [templates, setTemplates] = useState<CtPrintTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CtPrintTemplate | null>(null);
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    printApi
      .list()
      .then(setTemplates)
      .catch((e: Error) => setError(e.message));
  }, []);

  const upsert = (t: CtPrintTemplate) => setTemplates((cur) => (cur?.some((x) => x.id === t.id) ? cur.map((x) => (x.id === t.id ? t : x)) : [...(cur ?? []), t]));

  /** An uploaded khuôn: only its picture (nothing is read from it). */
  const upload = async (f: File) => {
    setUploading(true);
    setError(null);
    try {
      const img = await printApi.uploadImage(f);
      const spec = normalizePrintSpec({ width: img.width, height: img.height, dpi: 300, widthMm: mmOf(img.width, 300), heightMm: mmOf(img.height, 300), faces: [{ id: newId(), name: "Mặt in", imageUrl: img.url, maskUrl: null, guideUrl: null }] });
      const t = await printApi.create({ name: f.name.replace(/\.[a-z0-9]+$/i, "") || "Khuôn upload", kind: "flat", spec });
      upsert(t);
      setEditing(t);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload thất bại");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">Khuôn in</h2>
          <p className="text-xs text-muted-foreground">
            Khung file in của từng loại phôi: vùng in (safe zone), phần không in, kích thước. Dùng lại cho mọi sản phẩm, brief v2 và mockup. Quần áo làm 1 nửa (nửa kia đối xứng), in nhiều mặt (trước / sau).
          </p>
        </div>
        <CtButton onClick={() => file.current?.click()} disabled={uploading}>
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Upload khuôn
        </CtButton>
        <input
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void upload(f);
          }}
        />
      </div>
      {error && <p className="mb-3 text-xs text-destructive">{error}</p>}
      {!templates ? (
        <Loader2 className="h-5 w-5 animate-spin" />
      ) : templates.length === 0 ? (
        <p className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">Chưa có khuôn — Upload khuôn.</p>
      ) : (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
          {templates.map((t) => (
            <button key={t.id} type="button" onClick={() => setEditing(t)} className="overflow-hidden rounded-xl border bg-card text-left hover:border-sky-500 hover:ring-1 hover:ring-sky-500">
              <div className="flex aspect-square items-center justify-center bg-muted/40 p-3">
                <KhuonPreview spec={t.spec} className="h-full w-full" />
              </div>
              <div className="p-3">
                <div className="truncate text-sm font-semibold">{t.name}</div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {t.spec.width}×{t.spec.height}px · {t.spec.dpi} dpi
                  {t.spec.faces.length > 1 && ` · ${t.spec.faces.length} mặt`}
                  {t.spec.mirror && " · đối xứng"}
                  {t.spec.blanks.length > 0 && ` · ${t.spec.blanks.length} phôi`}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
      {editing && (
        <KhuonEditor
          template={editing}
          onClose={() => setEditing(null)}
          onSaved={(t) => {
            upsert(t);
            setEditing(null);
          }}
          onDeleted={(id) => {
            setTemplates((cur) => (cur ?? []).filter((x) => x.id !== id));
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

/** The faces of a khuôn (or an AI round) side by side. */
function FacesView({ width, height, faces, spec }: { width: number; height: number; faces: CtPrintFace[]; spec?: CtPrintSpec }) {
  if (!faces.length && spec) return <KhuonPreview spec={spec} className="max-h-[60vh] w-full" />;
  return (
    <div className={cx("grid gap-3", faces.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
      {faces.map((f) => (
        <figure key={f.id} className="space-y-1">
          <div className="flex items-center justify-center overflow-hidden rounded-lg border bg-white" style={{ aspectRatio: `${width} / ${height}`, maxHeight: "60vh" }}>
            {f.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- our R2 picture
              <img src={f.imageUrl} alt={f.name} className="h-full w-full object-contain" />
            ) : (
              <span className="text-xs text-muted-foreground">Chưa có hình</span>
            )}
          </div>
          <figcaption className="text-center text-[11px] text-muted-foreground">{f.name}</figcaption>
        </figure>
      ))}
    </div>
  );
}

/** A khuôn: its picture, name, sheet size, dpi, half-or-whole. Its phôi are on the Phôi tab. */
function KhuonEditor({ template, onClose, onSaved, onDeleted }: { template: CtPrintTemplate; onClose: () => void; onSaved: (t: CtPrintTemplate) => void; onDeleted: (id: string) => void }) {
  const [name, setName] = useState(template.name);
  const [spec, setSpec] = useState<CtPrintSpec>(template.spec);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<CtPrintSpec>) => setSpec((cur) => ({ ...cur, ...patch }));

  const save = async () => {
    setBusy("Đang lưu…");
    setError(null);
    try {
      const next = normalizePrintSpec({ ...spec, widthMm: mmOf(spec.width, spec.dpi), heightMm: mmOf(spec.height, spec.dpi) });
      onSaved(await printApi.update(template.id, { name: name.trim() || template.name, spec: next }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không lưu được");
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!(await ctConfirm({ title: `Xoá khuôn “${template.name}”?`, message: "Sản phẩm đã tạo từ khuôn giữ bản sao của nó.", tone: "danger", confirmLabel: "Xoá" }))) return;
    try {
      await printApi.remove(template.id);
      onDeleted(template.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không xoá được");
    }
  };

  return (
    <CtModal open onOpenChange={(o) => !o && !busy && onClose()} title={template.name} wide>
      <div className="grid gap-4 text-sm md:grid-cols-[1.2fr_1fr]">
        <div className="space-y-2">
          <FacesView width={spec.width} height={spec.height} faces={spec.faces} spec={spec} />
        </div>
        <div className="space-y-3">
          <CtField label="Tên">
            <CtInput value={name} onChange={(e) => setName(e.target.value)} />
          </CtField>
          <div className="grid grid-cols-3 gap-2">
            <CtField label="Rộng px">
              <CtNumber value={spec.width} min={16} max={20000} onChange={(width) => set({ width })} />
            </CtField>
            <CtField label="Cao px">
              <CtNumber value={spec.height} min={16} max={20000} onChange={(height) => set({ height })} />
            </CtField>
            <CtField label="DPI">
              <CtNumber value={spec.dpi} min={30} max={1200} onChange={(dpi) => set({ dpi })} />
            </CtField>
          </div>
          <p className="text-[11px] text-muted-foreground">
            ≈ {mmOf(spec.width, spec.dpi)} × {mmOf(spec.height, spec.dpi)} mm{spec.faces.length > 1 ? ` · ${spec.faces.length} mặt in: ${spec.faces.map((f) => f.name).join(", ")}` : ""}
          </p>
          <CtCheckbox checked={spec.mirror} onChange={(mirror) => set({ mirror })} label="Chỉ làm 1 nửa — nửa kia đối xứng" hint="File in tự ghép bản lật gương bên cạnh." />
          {spec.history.length > 0 && (
            <details className="text-[11px] text-muted-foreground">
              <summary className="cursor-pointer">Lịch sử ({spec.history.length})</summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {spec.history.map((h, i) => (
                  <li key={i}>{h.prompt || "(chỉ ảnh mẫu)"}</li>
                ))}
              </ul>
            </details>
          )}
          {busy && <p className="flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> {busy}</p>}
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex items-center gap-2 border-t pt-3">
            <CtButton variant="ghost" className="text-destructive" onClick={() => void remove()}>
              <Trash2 className="h-3.5 w-3.5" /> Xoá
            </CtButton>
            <span className="flex-1" />
            <CtButton onClick={onClose}>Huỷ</CtButton>
            <CtButton variant="primary" disabled={!!busy} onClick={() => void save()}>
              Lưu
            </CtButton>
          </div>
        </div>
      </div>
    </CtModal>
  );
}
