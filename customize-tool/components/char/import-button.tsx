"use client";

/**
 * "Import bộ" (asked 2026-10-29): a folder of finished files — a Teeinblue export that already sells — becomes a bộ
 * nhân vật with its product (server/char/import.ts). The folder is picked here, sent a few files a request, then the
 * server reads it (a known format) or hands it to @flexiprint (any other), and the set's page shows the build.
 */

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FolderUp, Loader2 } from "lucide-react";
import type { CtCharImportFile } from "../../types";
import { charApi } from "../../lib/api-client";
import { CtButton } from "../ui";
import { ctConfirm } from "../dialogs";

/** Files of an import request: about this many bytes, at most this many files. */
const BATCH_BYTES = 8 * 1024 * 1024;
const BATCH_FILES = 30;
const PARALLEL = 4;

const JUNK = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|__MACOSX)(\/|$)|(^|\/)\._/i;
const KEEP = /\.(png|jpe?g|webp|json|csv|md|txt|ttf|otf)$/i;

interface Picked {
  file: File;
  path: string;
}

/**
 * What is sent: every image / note / font of the folder. A Teeinblue hand-off (folders with teeinblue.json) brings its
 * layers there whole-canvas, so its other copies (cut clipart, print files per case) stay home — only those folders,
 * the files at the top (mockups, the sample, the sales text) and the notes go.
 */
function selectFiles(all: Picked[]): Picked[] {
  const files = all.filter((f) => !JUNK.test(f.path) && KEEP.test(f.path));
  const cases = files.filter((f) => /(^|\/)teeinblue\.json$/i.test(f.path)).map((f) => f.path.split("/").slice(0, -1).join("/"));
  if (!cases.length) return files;
  return files.filter((f) => !f.path.includes("/") || /\.(json|csv|md|txt)$/i.test(f.path) || cases.some((d) => f.path.startsWith(`${d}/`)));
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n > 100 * 1024 * 1024 ? 0 : 1)} MB`;

export function ImportButton({ onError }: { onError: (msg: string) => void }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; bytes: number; allBytes: number } | null>(null);

  const run = async (list: FileList | null) => {
    if (!list?.length) return;
    const all: Picked[] = [...list].map((file) => {
      const rel = file.webkitRelativePath || file.name;
      return { file, path: rel.split("/").slice(1).join("/") || file.name };
    });
    const top = (list[0].webkitRelativePath || "").split("/")[0] || "Bộ import";
    const files = selectFiles(all);
    const allBytes = files.reduce((n, f) => n + f.file.size, 0);
    if (!files.length) {
      onError("Folder không có ảnh / ghi chú nào để import");
      return;
    }
    const left = all.length - files.length;
    if (
      !(await ctConfirm({
        title: `Import “${top}”?`,
        message: `Tải lên ${files.length} file (${mb(allBytes)})${left ? `, bỏ ${left} file không cần (bản cắt sẵn, file hệ thống…)` : ""}. Xong thì hệ thống tự đọc bộ (Teeinblue) hoặc nhờ @flexiprint phân tích, rồi dựng bộ nhân vật + sản phẩm.`,
        confirmLabel: "Import",
      }))
    )
      return;
    setProgress({ done: 0, total: files.length, bytes: 0, allBytes });
    try {
      const project = await charApi.createImport(top);
      // Batches by size, a few at once.
      const batches: Picked[][] = [];
      let cur: Picked[] = [];
      let size = 0;
      for (const f of files) {
        if (cur.length && (cur.length >= BATCH_FILES || size + f.file.size > BATCH_BYTES)) {
          batches.push(cur);
          cur = [];
          size = 0;
        }
        cur.push(f);
        size += f.file.size;
      }
      if (cur.length) batches.push(cur);
      const uploaded: CtCharImportFile[] = [];
      let next = 0;
      const worker = async () => {
        for (let i = next++; i < batches.length; i = next++) {
          const b = batches[i];
          // A dropped request is sent again (a long upload over a slow line).
          let got: CtCharImportFile[] | null = null;
          for (let attempt = 0; attempt < 3 && !got; attempt++) {
            try {
              got = await charApi.importFiles(project.id, b);
            } catch (e) {
              if (attempt === 2) throw e;
            }
          }
          uploaded.push(...(got ?? []));
          setProgress((p) => (p ? { ...p, done: p.done + b.length, bytes: p.bytes + b.reduce((n, f) => n + f.file.size, 0) } : p));
        }
      };
      await Promise.all(Array.from({ length: PARALLEL }, worker));
      await charApi.importStart(project.id, uploaded);
      router.push(`/v2/${project.id}`);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Import thất bại");
      setProgress(null);
    }
  };

  return (
    <>
      <input
        type="file"
        multiple
        className="hidden"
        ref={(el) => {
          input.current = el;
          // A whole folder (React has no typed prop for it).
          el?.setAttribute("webkitdirectory", "");
        }}
        onChange={(e) => {
          void run(e.target.files);
          e.target.value = "";
        }}
      />
      <CtButton onClick={() => input.current?.click()} disabled={progress !== null} title="Tải folder bộ clipart đã làm sẵn (Teeinblue…) → bộ nhân vật + sản phẩm">
        {progress ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderUp className="h-4 w-4" />} Import bộ
      </CtButton>
      {progress && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-[420px] max-w-[calc(100vw-32px)] rounded-xl border bg-card p-5 shadow-xl">
            <div className="mb-2 text-sm font-semibold">Đang tải folder lên…</div>
            <div className="h-2 overflow-hidden rounded bg-muted">
              <div className="h-full bg-sky-500 transition-all" style={{ width: `${Math.round((progress.bytes / Math.max(1, progress.allBytes)) * 100)}%` }} />
            </div>
            <div className="mt-2 text-xs text-muted-foreground">
              {progress.done} / {progress.total} file · {mb(progress.bytes)} / {mb(progress.allBytes)} — đừng đóng trang
            </div>
          </div>
        </div>
      )}
    </>
  );
}
