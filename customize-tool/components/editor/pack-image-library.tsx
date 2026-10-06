"use client";

/**
 * Thư viện ảnh tổ hợp — where a tổ hợp Image frame gets its photo (server/pack-images.ts).
 *
 *   left   "Tải lên ảnh mới": pick a file, rename it, "Tải lên" → saved to the library as
 *          <name>_<timestamp>.<ext> and used right away. Tabs Tất cả / Ảnh bạn tải lên / Ảnh AI, search
 *          by name; click a photo to use it.
 *   right  "Tạo ảnh với AI": a description + reference photos (files, dropped, or picked from the library) go to
 *          the @flexiprint agent as a pack_image task (server/agent/tasks.ts): it reads the request, looks in the
 *          library, writes a prompt per photo and makes them with MCP generate_pack_image (Nano Banana; layers cut
 *          out), looks at them, fixes, asks when unsure — all live here — and hands back the photos it kept.
 *          Every photo shows the prompt it was made with: edit it → "Tạo lại với prompt này" (drawn directly, as
 *          written); "Chỉnh tiếp" sends the photo back to the agent with what to change. Agent offline → the
 *          server's one-shot prompt writer makes it instead.
 *
 * Everything saved here can be reused in later edits and by the @flexiprint agent (MCP list_pack_images).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, ImagePlus, Images, Loader2, Pencil, RotateCcw, Search, Sparkles, Trash2, Upload, Wand2, X } from "lucide-react";
import type { CtAgentTask, CtPackImage, CtPackImageAspect, CtPackImageResult } from "../../types";
import { ctApi } from "../../lib/api-client";
import { fileStem, IMAGE_EXT } from "../../lib/file-name";
import { CHECKER_STYLE, CtButton, CtInput, CtModal, CtSelect, CtTextarea, cx } from "../ui";
import { ctConfirm } from "../dialogs";
import { toUploadable } from "./scene-dialog";
import { AgentBadge, AgentProgress, useAgentStatus } from "../library/agent-brain";
import { defaultCategoryRules } from "../../lib/library";

type Scope = "all" | "mine" | "ai";

const ASPECTS: CtPackImageAspect[] = ["1:1", "4:5", "3:4", "2:3", "4:3", "3:2", "16:9", "9:16"];
const MAX_REFS = 6;
/** dataTransfer type of a library photo dragged onto the AI references (its url). */
const LIBRARY_DRAG = "application/x-ct-pack-image";

/** The offered aspect closest to w×h. */
export function nearestAspect(w: number, h: number): CtPackImageAspect {
  const r = w / h;
  const ratio = (a: CtPackImageAspect) => {
    const [x, y] = a.split(":").map(Number);
    return x / y;
  };
  return ASPECTS.reduce((best, a) => (Math.abs(Math.log(ratio(a) / r)) < Math.abs(Math.log(ratio(best) / r)) ? a : best), "1:1");
}

function pickFiles(multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*,.avif,.heic,.heif";
    input.multiple = multiple;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.click();
  });
}

/** A chosen file, converted to PNG / JPEG / WebP, with its preview and the name it will be saved under. */
interface Pending {
  blob: Blob;
  preview: string;
  name: string;
}

/** A reference photo for the AI: already in the library (url), or a new file. */
type Ref = { kind: "url"; url: string } | { kind: "file"; blob: Blob; preview: string };

export interface PackImageLibraryProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The photo picked (or just uploaded / generated and clicked). */
  onPick: (image: CtPackImage) => void;
  /** Default aspect for AI photos (the edit frame's). */
  aspect: CtPackImageAspect;
}

export function PackImageLibrary(props: PackImageLibraryProps) {
  const { open } = props;
  const [scope, setScope] = useState<Scope>("all");
  const [query, setQuery] = useState("");
  const [images, setImages] = useState<CtPackImage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [uploading, setUploading] = useState(false);

  // AI
  const [description, setDescription] = useState("");
  const [refs, setRefs] = useState<Ref[]>([]);
  const [aspect, setAspect] = useState<CtPackImageAspect>(props.aspect);
  const [pickingRef, setPickingRef] = useState(false);
  /** The photo "Chỉnh tiếp" sends back with the request. */
  const [base, setBase] = useState<CtPackImage | null>(null);
  const [starting, setStarting] = useState(false);
  const agent = useAgentStatus();
  const agentOn = !!agent?.configured && agent.online;
  /** @flexiprint's pack_image tasks, newest first. */
  const [tasks, setTasks] = useState<CtAgentTask[]>([]);
  /** Every AI photo in the library (task results + direct ones), and the direct ones still running. */
  const [aiImages, setAiImages] = useState<CtPackImage[]>([]);

  // The grid: reload on scope / search (debounced).
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const t = setTimeout(() => {
      setLoading(true);
      ctApi
        .listPackImages(scope, query.trim())
        .then((list) => !cancelled && setImages(list))
        .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Không tải được thư viện"))
        .finally(() => !cancelled && setLoading(false));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, scope, query, reload]);

  // The AI history: the agent's tasks and the AI photos (direct ones are entries of their own).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    ctApi
      .listAgentTasks("pack_image")
      .then((list) => !cancelled && setTasks(list))
      .catch(() => undefined);
    ctApi
      .listPackImages("ai")
      .then((list) => !cancelled && setAiImages(list))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, reload]);

  // Open tasks and running direct photos: polled; one that ends refreshes the grid and the history.
  const openTaskIds = tasks
    .filter((t) => t.status === "pending" || t.status === "running" || t.status === "waiting")
    .map((t) => t.id)
    .join(",");
  const runningIds = aiImages
    .filter((h) => h.status === "running")
    .map((h) => h.id)
    .join(",");
  useEffect(() => {
    if (!open || (!openTaskIds && !runningIds)) return;
    const t = setInterval(() => {
      const taskIds = openTaskIds ? openTaskIds.split(",") : [];
      const imageIds = runningIds ? runningIds.split(",") : [];
      void Promise.all([
        Promise.all(taskIds.map((id) => ctApi.agentTask(id).catch(() => null))),
        Promise.all(imageIds.map((id) => ctApi.getPackImage(id).catch(() => null))),
      ]).then(([ts, ims]) => {
        const freshT = ts.filter((x): x is CtAgentTask => x !== null);
        const freshI = ims.filter((x): x is CtPackImage => x !== null);
        setTasks((list) => list.map((x) => freshT.find((f) => f.id === x.id) ?? x));
        setAiImages((list) => list.map((x) => freshI.find((f) => f.id === x.id) ?? x));
        const ended = freshT.some((f) => !["pending", "running", "waiting"].includes(f.status)) || freshI.some((f) => f.status !== "running");
        if (ended) setReload((n) => n + 1);
      });
    }, 2500);
    return () => clearInterval(t);
  }, [open, openTaskIds, runningIds]);

  // Object urls of previews are freed when replaced / closed.
  const previews = useRef<string[]>([]);
  const preview = (blob: Blob) => {
    const u = URL.createObjectURL(blob);
    previews.current.push(u);
    return u;
  };
  // Mounted per opening (PreviewPanel): everything resets with it; previews are freed when it goes.
  useEffect(() => {
    const list = previews.current;
    return () => list.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  const chooseFile = async () => {
    const [file] = await pickFiles(false);
    if (!file) return;
    setError(null);
    try {
      const blob = await toUploadable(file);
      setPending({
        blob,
        preview: preview(blob),
        name: file.name.replace(/\.[^.]+$/, ""),
      });
    } catch {
      setError("Không mở được ảnh này");
    }
  };

  const upload = async () => {
    if (!pending) return;
    setUploading(true);
    setError(null);
    try {
      const image = await ctApi.uploadPackLibraryImage(pending.blob, pending.name.trim() || "Ảnh");
      setPending(null);
      setReload((n) => n + 1);
      props.onPick(image);
      props.onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload thất bại");
    } finally {
      setUploading(false);
    }
  };

  const pick = (image: CtPackImage) => {
    if (image.status !== "done" || !image.url) return;
    if (pickingRef) return addRefUrl(image.url);
    props.onPick(image);
    props.onOpenChange(false);
  };

  const remove = async (image: CtPackImage) => {
    if (
      !(await ctConfirm({
        title: `Xoá “${image.name}”?`,
        message: "Ảnh bị xoá khỏi thư viện. Các tổ hợp đã dùng ảnh này sẽ mất ảnh.",
        confirmLabel: "Xoá",
      }))
    )
      return;
    try {
      await ctApi.deletePackImage(image.id);
      setReload((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Xoá thất bại");
    }
  };

  const addRefFiles = async (picked?: File[]) => {
    const files = (picked ?? (await pickFiles(true))).filter((f) => f.type.startsWith("image/") || /\.(avif|heic|heif)$/i.test(f.name));
    const room = MAX_REFS - refs.length;
    const blobs = await Promise.all(files.slice(0, room).map((f) => toUploadable(f).catch(() => null)));
    setRefs((r) =>
      [...r, ...blobs.filter((b): b is Blob => b !== null).map((blob): Ref => ({ kind: "file", blob, preview: preview(blob) }))].slice(0, MAX_REFS),
    );
  };

  const addRefUrl = (url: string) => setRefs((r) => (r.length >= MAX_REFS || r.some((x) => x.kind === "url" && x.url === url) ? r : [...r, { kind: "url", url }]));

  /** Reference drop zone: files from the computer, or a photo dragged from the library grid. */
  const [dropping, setDropping] = useState(false);
  const onRefDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropping(false);
    const url = e.dataTransfer.getData(LIBRARY_DRAG);
    if (url) return addRefUrl(url);
    if (e.dataTransfer.files.length) void addRefFiles([...e.dataTransfer.files]);
  };

  /** The request → @flexiprint (or, agent offline, the server's own prompt writer). */
  const send = async () => {
    if (!description.trim()) return setError("Mô tả ảnh cần tạo");
    setStarting(true);
    setError(null);
    try {
      const files = refs.flatMap((r) => (r.kind === "file" ? [r.blob] : []));
      const urls = refs.flatMap((r) => (r.kind === "url" ? [r.url] : []));
      if (agentOn) {
        // The agent reads urls: new files go to storage first.
        for (const f of files) urls.push((await ctApi.uploadPackImage(f)).url);
        const task = await ctApi.createAgentTask({
          kind: "pack_image",
          input: {
            category: { id: null, name: "", spec: "", rules: defaultCategoryRules() },
            note: "",
            images: [],
            refUrls: urls,
            pack: { description: description.trim(), aspect, baseId: base?.id ?? null, baseUrl: base?.url ?? "" },
          },
        });
        setTasks((list) => [task, ...list]);
      } else {
        const image = await ctApi.generatePackImage({ description: description.trim(), aspect, refs: urls, files, parentId: base?.id ?? null });
        setAiImages((list) => [image, ...list]);
      }
      setDescription("");
      setRefs([]);
      setBase(null);
      setPickingRef(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tạo được ảnh");
    } finally {
      setStarting(false);
    }
  };

  /** Draw again from an edited prompt, as written (same references, same aspect, same cut-out). */
  const redraw = async (img: CtPackImage, prompt: string) => {
    setError(null);
    try {
      const image = await ctApi.generatePackImage({
        description: img.description,
        aspect: ASPECTS.includes(img.aspect as CtPackImageAspect) ? (img.aspect as CtPackImageAspect) : aspect,
        refs: img.refs,
        files: [],
        prompt,
        transparent: img.transparent,
      });
      setAiImages((list) => [image, ...list]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tạo được ảnh");
    }
  };

  /** "Chỉnh tiếp": the photo goes back with the next request. */
  const keepEditing = (img: CtPackImage) => {
    setBase(img);
    setDescription("");
    composer.current?.focus();
  };
  const composer = useRef<HTMLTextAreaElement | null>(null);

  const reuse = (description: string, refUrls: string[], a: string) => {
    setDescription(description);
    setAspect(ASPECTS.includes(a as CtPackImageAspect) ? (a as CtPackImageAspect) : aspect);
    setRefs(refUrls.map((url): Ref => ({ kind: "url", url })));
  };

  const answer = async (task: CtAgentTask, questionId: string, choices: string[], text: string) => {
    const t = await ctApi.answerAgentTask(task.id, { question_id: questionId, choices, text });
    setTasks((list) => list.map((x) => (x.id === t.id ? t : x)));
  };
  const cancel = async (task: CtAgentTask) => {
    const t = await ctApi.cancelAgentTask(task.id).catch(() => null);
    if (t) setTasks((list) => list.map((x) => (x.id === t.id ? t : x)));
  };

  /** History, newest first: the agent's tasks, and photos drawn directly (not by a task). */
  const entries = useMemo(
    () =>
      [
        ...tasks.map((t) => ({ at: t.created_at, task: t, image: null })),
        ...aiImages.filter((i) => !i.task_id).map((i) => ({ at: i.created_at, task: null, image: i })),
      ].sort((a, b) => b.at.localeCompare(a.at)),
    [tasks, aiImages],
  );
  const byId = useMemo(() => new Map(aiImages.map((i) => [i.id, i])), [aiImages]);

  const savedAs = useMemo(() => (pending ? `${fileStem(pending.name)}_{timestamp}.${IMAGE_EXT[pending.blob.type] ?? "png"}` : ""), [pending]);
  const shown = images.filter((i) => i.status === "done" && i.url);

  return (
    <CtModal open={open} onOpenChange={props.onOpenChange} title="Thư viện ảnh tổ hợp" wide>
      <div className="grid min-h-[60vh] grid-cols-[1fr_340px] gap-4">
        {/* Library */}
        <div className="flex min-w-0 flex-col gap-3">
          {pending ? (
            <div className="flex flex-wrap items-end gap-2 rounded-lg border p-2">
              <span className="h-14 w-14 shrink-0 overflow-hidden rounded border" style={CHECKER_STYLE}>
                <img src={pending.preview} alt="" className="h-full w-full object-cover" />
              </span>
              <CtButton size="sm" onClick={() => void chooseFile()} disabled={uploading}>
                <Upload className="h-3.5 w-3.5" /> Đổi tệp
              </CtButton>
              <label className="min-w-48 flex-1 text-[11px] text-muted-foreground">
                Tên tệp <span className="opacity-70">(đổi tên trước khi tải lên)</span>
                <CtInput
                  value={pending.name}
                  onChange={(e) => setPending({ ...pending, name: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && void upload()}
                  autoFocus
                />
              </label>
              <CtButton variant="primary" size="sm" onClick={() => void upload()} disabled={uploading || !pending.name.trim()}>
                {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Tải lên
              </CtButton>
              <CtButton size="icon" variant="ghost" onClick={() => setPending(null)} disabled={uploading} aria-label="Huỷ">
                <X className="h-4 w-4" />
              </CtButton>
              <p className="w-full text-[11px] text-muted-foreground">
                Sẽ lưu thành: <code>{savedAs}</code>
              </p>
            </div>
          ) : (
            <div>
              <CtButton onClick={() => void chooseFile()}>
                <Upload className="h-4 w-4" /> Tải lên ảnh mới
              </CtButton>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-md border p-0.5 text-xs">
              {(
                [
                  ["all", "Tất cả"],
                  ["mine", "Ảnh bạn tải lên"],
                  ["ai", "Ảnh AI"],
                ] as Array<[Scope, string]>
              ).map(([id, label]) => (
                <button
                  key={id}
                  className={cx("rounded px-3 py-1", scope === id ? "bg-foreground text-background" : "hover:bg-accent")}
                  onClick={() => setScope(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="relative min-w-48 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <CtInput className="pl-8" placeholder="Tìm kiếm ảnh theo tên…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
          </div>

          {pickingRef && (
            <div className="flex items-center gap-2 rounded-md border border-violet-500/50 bg-violet-500/10 px-3 py-1.5 text-xs">
              <Sparkles className="h-3.5 w-3.5 text-violet-500" /> Click ảnh để thêm làm ảnh tham khảo cho AI ({refs.length}/{MAX_REFS})
              <CtButton size="sm" variant="ghost" className="ml-auto" onClick={() => setPickingRef(false)}>
                Xong
              </CtButton>
            </div>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="grid max-h-[60vh] grid-cols-[repeat(auto-fill,minmax(150px,1fr))] content-start gap-3 overflow-y-auto pr-1">
            {shown.map((img) => {
              const asRef = pickingRef && refs.some((r) => r.kind === "url" && r.url === img.url);
              return (
                <div key={img.id} className="group relative">
                  <button
                    className={cx("block w-full overflow-hidden rounded-lg border text-left hover:border-sky-500", asRef && "ring-2 ring-violet-500")}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(LIBRARY_DRAG, img.url ?? "");
                      e.dataTransfer.effectAllowed = "copy";
                    }}
                    onClick={() => pick(img)}
                    title={img.source === "ai" ? img.description : img.name}
                  >
                    <span className="block aspect-square" style={CHECKER_STYLE}>
                      <img src={img.url ?? ""} alt="" className="h-full w-full object-cover" loading="lazy" />
                    </span>
                    <span className="block truncate border-t bg-background px-2 py-1 text-[11px]">{img.name}</span>
                  </button>
                  {img.source === "ai" && <Sparkles className="absolute left-1.5 top-1.5 h-3.5 w-3.5 text-violet-400 drop-shadow" />}
                  <button
                    className="absolute right-1.5 top-1.5 hidden rounded bg-black/70 p-1 text-white hover:bg-destructive group-hover:block"
                    onClick={() => void remove(img)}
                    title="Xoá khỏi thư viện"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
            {!loading && !shown.length && <p className="col-span-full py-10 text-center text-xs text-muted-foreground">Chưa có ảnh nào.</p>}
            {loading && !shown.length && <Loader2 className="col-span-full mx-auto my-10 h-5 w-5 animate-spin text-muted-foreground" />}
          </div>
        </div>

        {/* AI */}
        <div className="flex min-h-0 flex-col gap-2 border-l pl-4">
          <p className="flex items-center gap-1.5 text-sm font-semibold">
            <Sparkles className="h-4 w-4 text-violet-500" /> Tạo ảnh với AI
            <span className="ml-auto">
              <AgentBadge status={agent} />
            </span>
          </p>
          {base && (
            <div className="flex items-center gap-2 rounded-md border border-violet-500/40 bg-violet-500/5 p-1.5 text-[11px]">
              <span className="h-10 w-10 shrink-0 overflow-hidden rounded border" style={CHECKER_STYLE}>
                <img src={base.url ?? ""} alt="" className="h-full w-full object-cover" />
              </span>
              <span className="min-w-0 flex-1">
                Chỉnh tiếp <b className="truncate">{base.name}</b> — viết cần đổi gì
              </span>
              <button className="rounded p-1 hover:bg-accent" onClick={() => setBase(null)} aria-label="Bỏ">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <CtTextarea
            ref={composer}
            rows={4}
            placeholder={
              base
                ? "Cần sửa gì — vd: móng đỏ nhung, thêm bông tuyết nhỏ, giữ nguyên dáng tay"
                : "Mô tả ảnh cần tạo — càng rõ càng tốt: mấy tấm, mỗi tấm có gì, tấm nào là layer tách nền, vị trí (góc dưới trái…)"
            }
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <div
            className={cx(
              "flex min-h-16 flex-wrap items-center gap-1.5 rounded-lg border border-dashed p-1.5",
              dropping ? "border-violet-500 bg-violet-500/10" : "border-border",
            )}
            onDragOver={(e) => {
              if (refs.length >= MAX_REFS || !(e.dataTransfer.types.includes("Files") || e.dataTransfer.types.includes(LIBRARY_DRAG))) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              setDropping(true);
            }}
            onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDropping(false)}
            onDrop={onRefDrop}
          >
            {!refs.length && (
              <span className="w-full text-center text-[11px] text-muted-foreground">Kéo thả ảnh tham khảo vào đây (từ máy hoặc từ thư viện bên trái)</span>
            )}
            {refs.map((r, i) => (
              <span key={i} className="group relative h-12 w-12 overflow-hidden rounded border" style={CHECKER_STYLE}>
                <img src={r.kind === "url" ? r.url : r.preview} alt="" className="h-full w-full object-cover" />
                <span className="absolute left-0.5 top-0.5 rounded bg-black/70 px-1 text-[9px] text-white">{i + 1}</span>
                <button
                  className="absolute right-0.5 top-0.5 hidden rounded-full bg-black/70 p-0.5 text-white group-hover:block"
                  onClick={() => setRefs((list) => list.filter((_, j) => j !== i))}
                  aria-label="Bỏ ảnh tham khảo"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
            {refs.length < MAX_REFS && (
              <>
                <CtButton size="sm" variant="outline" onClick={() => void addRefFiles()}>
                  <ImagePlus className="h-3.5 w-3.5" /> Ảnh tham khảo
                </CtButton>
                <CtButton size="sm" variant={pickingRef ? "primary" : "outline"} onClick={() => setPickingRef(!pickingRef)}>
                  <Images className="h-3.5 w-3.5" /> Từ thư viện
                </CtButton>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">Tỉ lệ</span>
            <CtSelect<CtPackImageAspect> className="h-8 w-24" value={aspect} onChange={setAspect} options={ASPECTS.map((a) => ({ value: a, label: a }))} />
            <CtButton variant="primary" size="sm" className="ml-auto" onClick={() => void send()} disabled={starting || !description.trim()}>
              {starting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : agentOn ? <Bot className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
              {agentOn ? "Gửi @flexiprint" : "Tạo ảnh"}
            </CtButton>
          </div>
          <p className="text-[10px] text-muted-foreground">
            {agentOn
              ? "@flexiprint đọc yêu cầu + ảnh tham khảo, tìm trong thư viện, viết prompt cho từng ảnh, tạo (Nano Banana, layer được tách nền), tự xem và sửa, hỏi lại khi cần. Có tính phí fal.ai."
              : "@flexiprint chưa sẵn sàng — FlexiPrint tự viết prompt và tạo 1 ảnh (fal.ai, có tính phí)."}
          </p>

          <p className="mt-2 text-[11px] font-semibold uppercase text-muted-foreground">Lịch sử tạo ảnh</p>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
            {entries.map((en) =>
              en.task ? (
                <TaskEntry
                  key={en.task.id}
                  task={en.task}
                  images={((en.task.result as CtPackImageResult | null)?.imageIds ?? []).map((id) => byId.get(id)).filter((x): x is CtPackImage => !!x)}
                  onAnswer={(q, c, t) => answer(en.task, q, c, t)}
                  onCancel={() => void cancel(en.task)}
                  onReuse={() => reuse(en.task.input.pack?.description ?? "", en.task.input.refUrls, en.task.input.pack?.aspect ?? aspect)}
                  photo={(img) => <PhotoCard key={img.id} image={img} onUse={() => pick(img)} onRedraw={(p) => redraw(img, p)} onEdit={() => keepEditing(img)} />}
                />
              ) : en.image ? (
                <div key={en.image.id} className="space-y-1.5 rounded-lg border p-2 text-[11px]">
                  {en.image.description && <p className="line-clamp-3">{en.image.description}</p>}
                  <p className="text-muted-foreground">
                    {new Date(en.image.created_at).toLocaleString("vi-VN")} · {en.image.aspect} · tạo trực tiếp
                    {en.image.status === "running" && (en.image.prompt ? " · đang tạo ảnh…" : " · đang viết prompt…")}
                  </p>
                  <PhotoCard image={en.image} onUse={() => en.image && pick(en.image)} onRedraw={(p) => en.image && redraw(en.image, p)} onEdit={() => en.image && keepEditing(en.image)} />
                </div>
              ) : null,
            )}
            {!entries.length && <p className="text-muted-foreground">Chưa tạo ảnh nào.</p>}
          </div>
        </div>
      </div>
    </CtModal>
  );
}

/** One request to @flexiprint: what was asked, the agent live (progress, its photos, its question), then the photos it kept. */
function TaskEntry(p: {
  task: CtAgentTask;
  images: CtPackImage[];
  onAnswer: (questionId: string, choices: string[], text: string) => Promise<void>;
  onCancel: () => void;
  onReuse: () => void;
  photo: (image: CtPackImage) => React.ReactNode;
}) {
  const { task } = p;
  const pack = task.input.pack;
  const open = task.status === "pending" || task.status === "running" || task.status === "waiting";
  const result = task.result as CtPackImageResult | null;
  return (
    <div className="space-y-1.5 rounded-lg border p-2 text-[11px]">
      <div className="flex gap-2">
        {pack?.baseUrl && (
          <span className="h-10 w-10 shrink-0 overflow-hidden rounded border" style={CHECKER_STYLE} title="Chỉnh tiếp từ ảnh này">
            <img src={pack.baseUrl} alt="" className="h-full w-full object-cover" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="line-clamp-4 whitespace-pre-line">{pack?.description}</p>
          <p className="text-muted-foreground">
            <Bot className="mr-0.5 inline h-3 w-3" />
            {new Date(task.created_at).toLocaleString("vi-VN")} · {pack?.aspect}
            {task.status === "cancelled" && " · đã dừng"}
          </p>
        </div>
      </div>
      {task.input.refUrls.length > 0 && (
        <div className="flex gap-1">
          {task.input.refUrls.map((u) => (
            <img key={u} src={u} alt="" className="h-7 w-7 rounded border object-cover" />
          ))}
        </div>
      )}
      {open && <AgentProgress task={task} onCancel={p.onCancel} onAnswer={p.onAnswer} />}
      {task.status === "done" && result?.summary && <p className="whitespace-pre-line rounded bg-violet-500/5 p-1.5">{result.summary}</p>}
      {p.images.length > 0 && <div className="space-y-2">{p.images.map((img) => p.photo(img))}</div>}
      {task.status === "failed" && <p className="text-destructive">{task.error || "Agent không trả kết quả"}</p>}
      {!open && (
        <CtButton size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={p.onReuse}>
          <RotateCcw className="h-3 w-3" /> Dùng lại yêu cầu
        </CtButton>
      )}
    </div>
  );
}

/** A made photo: use it, its prompt (edit → draw again as written), or keep editing it with the agent. */
function PhotoCard(p: { image: CtPackImage; onUse: () => void; onRedraw: (prompt: string) => Promise<void>; onEdit: () => void }) {
  const { image } = p;
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState(image.prompt);
  const [busy, setBusy] = useState(false);
  const done = image.status === "done" && !!image.url;
  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        <button
          className="h-20 w-20 shrink-0 overflow-hidden rounded border disabled:cursor-default"
          style={CHECKER_STYLE}
          disabled={!done}
          onClick={p.onUse}
          title={done ? "Dùng ảnh này" : undefined}
        >
          {done ? (
            <img src={image.url ?? ""} alt="" className="h-full w-full object-contain" />
          ) : image.status === "running" ? (
            <Loader2 className="m-auto h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <X className="m-auto h-4 w-4 text-destructive" />
          )}
        </button>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="truncate font-medium">{image.name}</p>
          {image.transparent && <span className="rounded bg-muted px-1 text-[10px]">nền trong suốt</span>}
          {image.status === "failed" && <p className="text-destructive">{image.error || "Tạo ảnh thất bại"}</p>}
          <div className="flex flex-wrap gap-1">
            {done && (
              <CtButton size="sm" variant="outline" className="h-6 px-1.5 text-[11px]" onClick={p.onUse}>
                <Check className="h-3 w-3" /> Dùng
              </CtButton>
            )}
            {done && (
              <CtButton size="sm" variant="outline" className="h-6 px-1.5 text-[11px]" onClick={p.onEdit}>
                <Wand2 className="h-3 w-3" /> Chỉnh tiếp
              </CtButton>
            )}
            {image.prompt && (
              <CtButton size="sm" variant={editing ? "primary" : "ghost"} className="h-6 px-1.5 text-[11px]" onClick={() => setEditing(!editing)}>
                <Pencil className="h-3 w-3" /> Prompt
              </CtButton>
            )}
          </div>
        </div>
      </div>
      {editing && (
        <div className="space-y-1">
          <CtTextarea rows={6} className="text-[11px]" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <div className="flex items-center gap-1">
            <CtButton
              size="sm"
              variant="primary"
              className="h-6 px-1.5 text-[11px]"
              disabled={busy || !prompt.trim()}
              onClick={() => {
                setBusy(true);
                void p.onRedraw(prompt.trim()).finally(() => {
                  setBusy(false);
                  setEditing(false);
                });
              }}
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />} Tạo lại với prompt này
            </CtButton>
            <span className="text-[10px] text-muted-foreground">vẽ đúng prompt, cùng ảnh tham khảo</span>
          </div>
        </div>
      )}
    </div>
  );
}
