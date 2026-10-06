"use client";

/**
 * Tạo ảnh với AI — the thư viện ảnh tổ hợp's AI workspace, full window.
 *
 *   left    bộ ảnh (ct_pack_collections): every request lives in a named bộ; "Bộ ảnh mới" asks its name. A bộ is one
 *           conversation with @flexiprint — its requests continue the same agent session, and get_task hands the
 *           agent the bộ's earlier requests and photos (server/mcp/tools.ts).
 *   centre  the bộ as a chat thread, oldest first: each request (the photos sent back with their own notes, the
 *           general request, references) and the agent's answer, live (progress, its photos, its question), then
 *           the photos it kept. Each photo: Dùng · Chỉnh tiếp (pick several, one note each) · Prompt (edit → drawn
 *           again as written); drag it into the composer to use it as a reference.
 *   bottom  the composer.
 *
 * Agent offline → the server's one-shot prompt writer draws instead (server/pack-images.ts).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, FolderPlus, ImagePlus, Images, Loader2, Pencil, Send, Sparkles, User, Wand2, X } from "lucide-react";
import type { CtAgentTask, CtPackCollection, CtPackImage, CtPackImageAspect, CtPackImageResult } from "../../types";
import { ctApi } from "../../lib/api-client";
import { packBases } from "../../lib/file-name";
import { defaultCategoryRules } from "../../lib/library";
import { CHECKER_STYLE, CtButton, CtModal, CtSelect, CtTextarea, cx } from "../ui";
import { ctPrompt } from "../dialogs";
import { AgentBadge, AgentProgress, useAgentStatus } from "../library/agent-brain";
import { toUploadable } from "./scene-dialog";

export const PACK_ASPECTS: CtPackImageAspect[] = ["1:1", "4:5", "3:4", "2:3", "4:3", "3:2", "16:9", "9:16"];
const MAX_REFS = 6;
/** dataTransfer type of a photo dragged from the thread onto the composer (its url). */
const PHOTO_DRAG = "application/x-ct-pack-photo";
/** The requests made before bộ ảnh existed. */
const LOOSE = "__loose__";

type Ref = { kind: "url"; url: string } | { kind: "file"; blob: Blob; preview: string };

function pickFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*,.avif,.heic,.heif";
    input.multiple = true;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.click();
  });
}

const isOpen = (t: CtAgentTask) => t.status === "pending" || t.status === "running" || t.status === "waiting";

export interface PackAiStudioProps {
  onClose: () => void;
  /** A photo to use in the frame (the studio and the library close). */
  onPick: (image: CtPackImage) => void;
  /** Default aspect for new photos (the edit frame's). */
  aspect: CtPackImageAspect;
  /** Something was saved to the library (the grid behind refreshes). */
  onChanged: () => void;
}

export function PackAiStudio(props: PackAiStudioProps) {
  const agent = useAgentStatus();
  const agentOn = !!agent?.configured && agent.online;
  const [collections, setCollections] = useState<CtPackCollection[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [tasks, setTasks] = useState<CtAgentTask[]>([]);
  const [photos, setPhotos] = useState<CtPackImage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  // Composer
  const [description, setDescription] = useState("");
  const [refs, setRefs] = useState<Ref[]>([]);
  const [aspect, setAspect] = useState<CtPackImageAspect>(props.aspect);
  const [bases, setBases] = useState<Array<{ image: CtPackImage; note: string }>>([]);
  const [sending, setSending] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [library, setLibrary] = useState<CtPackImage[] | null>(null);

  const previews = useRef<string[]>([]);
  useEffect(() => {
    const list = previews.current;
    return () => list.forEach((u) => URL.revokeObjectURL(u));
  }, []);
  const preview = (blob: Blob) => {
    const u = URL.createObjectURL(blob);
    previews.current.push(u);
    return u;
  };

  // The bộ list; the newest is opened at first.
  useEffect(() => {
    let cancelled = false;
    ctApi
      .listPackCollections()
      .then((list) => {
        if (cancelled) return;
        setCollections(list);
        setCurrent((c) => c ?? list[0]?.id ?? LOOSE);
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Không tải được bộ ảnh"));
    return () => {
      cancelled = true;
    };
  }, [reload]);

  // The open bộ's thread: its tasks and its photos (the loose list: requests before bộ ảnh).
  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    const loose = current === LOOSE;
    void Promise.all([ctApi.listAgentTasks("pack_image", loose ? null : current), ctApi.listPackImages("ai", "", loose ? null : current)])
      .then(([ts, ims]) => {
        if (cancelled) return;
        setTasks(loose ? ts.filter((t) => !t.input.pack?.collectionId) : ts);
        setPhotos(loose ? ims.filter((i) => !i.collection_id) : ims);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [current, reload]);

  // Open tasks and running photos are polled; one that ends reloads the thread.
  const openIds = tasks.filter(isOpen).map((t) => t.id).join(",");
  const runningIds = photos.filter((p) => p.status === "running").map((p) => p.id).join(",");
  useEffect(() => {
    if (!openIds && !runningIds) return;
    const t = setInterval(() => {
      void Promise.all([
        Promise.all((openIds ? openIds.split(",") : []).map((id) => ctApi.agentTask(id).catch(() => null))),
        Promise.all((runningIds ? runningIds.split(",") : []).map((id) => ctApi.getPackImage(id).catch(() => null))),
      ]).then(([ts, ims]) => {
        const ft = ts.filter((x): x is CtAgentTask => x !== null);
        const fi = ims.filter((x): x is CtPackImage => x !== null);
        setTasks((list) => list.map((x) => ft.find((f) => f.id === x.id) ?? x));
        setPhotos((list) => list.map((x) => fi.find((f) => f.id === x.id) ?? x));
        if (ft.some((f) => !isOpen(f)) || fi.some((f) => f.status !== "running")) {
          setReload((n) => n + 1);
          props.onChanged();
        }
      });
    }, 2500);
    return () => clearInterval(t);
  }, [openIds, runningIds, props]);

  /** The thread, oldest first: the agent's requests, and photos made outside them (redraws, offline). */
  const byId = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos]);
  const entries = useMemo(() => {
    const inTask = new Set(tasks.flatMap((t) => (t.result as CtPackImageResult | null)?.imageIds ?? []));
    return [
      ...tasks.map((t) => ({ at: t.created_at, task: t, photo: null })),
      ...photos.filter((p) => !p.task_id && !inTask.has(p.id)).map((p) => ({ at: p.created_at, task: null, photo: p })),
    ].sort((a, b) => a.at.localeCompare(b.at));
  }, [tasks, photos]);

  const end = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [entries.length, current]);

  const newCollection = async (): Promise<string | null> => {
    const name = await ctPrompt({ title: "Bộ ảnh mới", label: "Tên bộ ảnh", placeholder: "vd: Ngón tay cầm ornament Noel", confirmLabel: "Tạo bộ" });
    if (!name?.trim()) return null;
    try {
      const c = await ctApi.createPackCollection(name.trim());
      setCollections((list) => [c, ...list]);
      setCurrent(c.id);
      return c.id;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tạo được bộ ảnh");
      return null;
    }
  };

  const rename = async (c: CtPackCollection) => {
    const name = await ctPrompt({ title: "Đổi tên bộ ảnh", label: "Tên bộ ảnh", defaultValue: c.name, confirmLabel: "Lưu" });
    if (!name?.trim() || name.trim() === c.name) return;
    const next = await ctApi.renamePackCollection(c.id, name.trim()).catch(() => null);
    if (next) setCollections((list) => list.map((x) => (x.id === next.id ? next : x)));
  };

  const addRefFiles = async (files: File[]) => {
    const room = MAX_REFS - refs.length;
    const ok = files.filter((f) => f.type.startsWith("image/") || /\.(avif|heic|heif)$/i.test(f.name)).slice(0, room);
    const blobs = await Promise.all(ok.map((f) => toUploadable(f).catch(() => null)));
    setRefs((r) => [...r, ...blobs.filter((b): b is Blob => b !== null).map((blob): Ref => ({ kind: "file", blob, preview: preview(blob) }))].slice(0, MAX_REFS));
  };
  const addRefUrl = (url: string) => setRefs((r) => (r.length >= MAX_REFS || r.some((x) => x.kind === "url" && x.url === url) ? r : [...r, { kind: "url", url }]));

  const toggleBase = (img: CtPackImage) =>
    setBases((list) => (list.some((b) => b.image.id === img.id) ? list.filter((b) => b.image.id !== img.id) : [...list, { image: img, note: "" }].slice(0, 8)));
  const chosen = new Set(bases.map((b) => b.image.id));

  const send = async () => {
    if (!description.trim() && !bases.some((b) => b.note.trim())) return setError(bases.length ? "Viết yêu cầu cho ảnh cần chỉnh (hoặc yêu cầu chung)" : "Mô tả ảnh cần tạo");
    let collectionId = current && current !== LOOSE ? current : null;
    if (!collectionId) collectionId = await newCollection();
    if (!collectionId) return;
    setSending(true);
    setError(null);
    try {
      const files = refs.flatMap((r) => (r.kind === "file" ? [r.blob] : []));
      const urls = refs.flatMap((r) => (r.kind === "url" ? [r.url] : []));
      if (agentOn) {
        for (const f of files) urls.push((await ctApi.uploadPackImage(f)).url);
        const task = await ctApi.createAgentTask({
          kind: "pack_image",
          input: {
            category: { id: null, name: "", spec: "", rules: defaultCategoryRules() },
            note: "",
            images: [],
            refUrls: urls,
            pack: {
              description: description.trim(),
              aspect,
              bases: bases.map((b) => ({ id: b.image.id, url: b.image.url ?? "", name: b.image.name, note: b.note.trim() })),
              baseId: bases[0]?.image.id ?? null,
              baseUrl: bases[0]?.image.url ?? "",
              collectionId,
            },
          },
        });
        setTasks((list) => [...list, task]);
      } else {
        const jobs = bases.length
          ? bases.map((b) =>
              ctApi.generatePackImage({
                description: [b.note.trim() && `Yêu cầu riêng cho ảnh này (ưu tiên): ${b.note.trim()}`, description.trim() && `Yêu cầu chung: ${description.trim()}`].filter(Boolean).join("\n"),
                aspect: PACK_ASPECTS.includes(b.image.aspect as CtPackImageAspect) ? (b.image.aspect as CtPackImageAspect) : aspect,
                refs: urls,
                files,
                parentId: b.image.id,
                transparent: b.image.transparent,
                collectionId,
              }),
            )
          : [ctApi.generatePackImage({ description: description.trim(), aspect, refs: urls, files, collectionId })];
        const made = await Promise.all(jobs);
        setPhotos((list) => [...list, ...made]);
      }
      setDescription("");
      setRefs([]);
      setBases([]);
      setLibrary(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không gửi được");
    } finally {
      setSending(false);
    }
  };

  const redraw = async (img: CtPackImage, prompt: string) => {
    try {
      const made = await ctApi.generatePackImage({
        description: img.description,
        aspect: PACK_ASPECTS.includes(img.aspect as CtPackImageAspect) ? (img.aspect as CtPackImageAspect) : aspect,
        refs: img.refs,
        files: [],
        prompt,
        transparent: img.transparent,
        collectionId: img.collection_id ?? (current !== LOOSE ? current : null),
      });
      setPhotos((list) => [...list, made]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tạo được ảnh");
    }
  };

  const answer = async (task: CtAgentTask, questionId: string, choices: string[], text: string) => {
    const t = await ctApi.answerAgentTask(task.id, { question_id: questionId, choices, text });
    setTasks((list) => list.map((x) => (x.id === t.id ? t : x)));
  };
  const cancel = async (task: CtAgentTask) => {
    const t = await ctApi.cancelAgentTask(task.id).catch(() => null);
    if (t) setTasks((list) => list.map((x) => (x.id === t.id ? t : x)));
  };

  const openLibrary = async () => {
    if (library) return setLibrary(null);
    setLibrary(await ctApi.listPackImages("all").catch(() => []));
  };

  const card = (img: CtPackImage) => (
    <PhotoCard
      key={img.id}
      image={img}
      selected={chosen.has(img.id)}
      onUse={() => props.onPick(img)}
      onEdit={() => toggleBase(img)}
      onRedraw={(p) => redraw(img, p)}
    />
  );

  const currentName = current === LOOSE ? "Trước khi có bộ ảnh" : (collections.find((c) => c.id === current)?.name ?? "");
  return (
    <CtModal open onOpenChange={(o) => !o && props.onClose()} title="Tạo ảnh với AI" full>
      <div className="grid min-h-0 flex-1 grid-cols-[240px_1fr] gap-4">
        {/* Bộ ảnh */}
        <aside className="flex min-h-0 flex-col gap-2 border-r pr-3">
          <CtButton className="justify-center" onClick={() => void newCollection()}>
            <FolderPlus className="h-4 w-4" /> Bộ ảnh mới
          </CtButton>
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
            {collections.map((c) => (
              <button
                key={c.id}
                className={cx("group block w-full rounded-md px-2 py-1.5 text-left text-xs", c.id === current ? "bg-sky-500/15" : "hover:bg-accent")}
                onClick={() => setCurrent(c.id)}
                onDoubleClick={() => void rename(c)}
                title="Double-click để đổi tên"
              >
                <span className="block truncate font-medium">{c.name}</span>
                <span className="block text-[10px] text-muted-foreground">{new Date(c.updated_at).toLocaleString("vi-VN")}</span>
              </button>
            ))}
            <button
              className={cx("block w-full rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground", current === LOOSE ? "bg-sky-500/15" : "hover:bg-accent")}
              onClick={() => setCurrent(LOOSE)}
            >
              Trước khi có bộ ảnh
            </button>
          </div>
          <AgentBadge status={agent} />
        </aside>

        {/* Thread + composer */}
        <section className="flex min-h-0 flex-col">
          <div className="mb-2 flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold">{currentName}</h3>
            {current === LOOSE && <span className="text-[11px] text-muted-foreground">— gửi yêu cầu mới sẽ hỏi tên bộ ảnh</span>}
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-2">
            {entries.map((en) =>
              en.task ? (
                <TaskTurn
                  key={en.task.id}
                  task={en.task}
                  photos={((en.task.result as CtPackImageResult | null)?.imageIds ?? []).map((id) => byId.get(id)).filter((x): x is CtPackImage => !!x)}
                  card={card}
                  onAnswer={(q, c, t) => answer(en.task, q, c, t)}
                  onCancel={() => void cancel(en.task)}
                />
              ) : en.photo ? (
                <div key={en.photo.id} className="space-y-1">
                  <p className="text-[11px] text-muted-foreground">
                    {new Date(en.photo.created_at).toLocaleString("vi-VN")} ·{" "}
                    {en.photo.status === "running" ? (en.photo.prompt ? "đang tạo ảnh…" : "đang viết prompt…") : "tạo trực tiếp"}
                  </p>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">{card(en.photo)}</div>
                </div>
              ) : null,
            )}
            {!entries.length && (
              <p className="py-16 text-center text-sm text-muted-foreground">
                {current === LOOSE ? "Không có yêu cầu nào." : "Bộ ảnh trống — viết yêu cầu bên dưới: mấy tấm, mỗi tấm có gì, tấm nào là layer tách nền, vị trí."}
              </p>
            )}
            <div ref={end} />
          </div>

          {/* Composer */}
          <div className="mt-3 shrink-0 space-y-2 rounded-xl border bg-muted/20 p-3">
            {bases.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[11px] font-medium">Chỉnh tiếp {bases.length} ảnh — mỗi ảnh một yêu cầu riêng (ưu tiên hơn yêu cầu chung, chỉ áp cho ảnh đó)</p>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-2">
                  {bases.map((b, i) => (
                    <div key={b.image.id} className="flex gap-2 rounded-md border bg-background p-1.5">
                      <span className="relative h-16 w-16 shrink-0 overflow-hidden rounded border" style={CHECKER_STYLE}>
                        <img src={b.image.url ?? ""} alt="" className="h-full w-full object-contain" />
                        <span className="absolute left-0.5 top-0.5 rounded bg-black/70 px-1 text-[9px] text-white">{i + 1}</span>
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1 text-[11px]">
                          <span className="truncate font-medium">{b.image.name}</span>
                          <button className="ml-auto rounded p-0.5 hover:bg-accent" onClick={() => toggleBase(b.image)} aria-label="Bỏ ảnh này">
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                        <CtTextarea
                          rows={2}
                          className="text-[11px]"
                          placeholder="Yêu cầu riêng cho ảnh này"
                          value={b.note}
                          onChange={(e) => setBases((list) => list.map((x) => (x.image.id === b.image.id ? { ...x, note: e.target.value } : x)))}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div
              className={cx("rounded-lg border border-dashed p-1.5", dropping ? "border-violet-500 bg-violet-500/10" : "border-transparent")}
              onDragOver={(e) => {
                if (refs.length >= MAX_REFS || !(e.dataTransfer.types.includes("Files") || e.dataTransfer.types.includes(PHOTO_DRAG))) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
                setDropping(true);
              }}
              onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDropping(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDropping(false);
                // A photo of the thread, or files from the computer.
                const url = e.dataTransfer.getData(PHOTO_DRAG);
                if (url) addRefUrl(url);
                else void addRefFiles([...e.dataTransfer.files]);
              }}
            >
              <CtTextarea
                rows={3}
                placeholder={
                  bases.length
                    ? "Yêu cầu chung cho mọi ảnh trên (không bắt buộc)"
                    : "Mô tả ảnh cần tạo — mấy tấm, mỗi tấm có gì, tấm nào là layer tách nền, vị trí… (kéo ảnh ở trên hoặc từ máy thả vào đây làm ảnh tham khảo)"
                }
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
                }}
              />
              {refs.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {refs.map((r, i) => (
                    <span key={i} className="group relative h-12 w-12 overflow-hidden rounded border" style={CHECKER_STYLE}>
                      <img src={r.kind === "url" ? r.url : r.preview} alt="" className="h-full w-full object-cover" />
                      <button
                        className="absolute right-0.5 top-0.5 hidden rounded-full bg-black/70 p-0.5 text-white group-hover:block"
                        onClick={() => setRefs((list) => list.filter((_, j) => j !== i))}
                        aria-label="Bỏ ảnh tham khảo"
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
            {library && (
              <div className="grid max-h-40 grid-cols-[repeat(auto-fill,minmax(64px,1fr))] gap-1.5 overflow-y-auto rounded-md border bg-background p-1.5">
                {library
                  .filter((i) => i.url)
                  .map((i) => (
                    <button
                      key={i.id}
                      className={cx("aspect-square overflow-hidden rounded border", refs.some((r) => r.kind === "url" && r.url === i.url) && "ring-2 ring-violet-500")}
                      style={CHECKER_STYLE}
                      onClick={() => addRefUrl(i.url ?? "")}
                      title={i.name}
                    >
                      <img src={i.url ?? ""} alt="" className="h-full w-full object-cover" loading="lazy" />
                    </button>
                  ))}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <CtButton size="sm" variant="outline" disabled={refs.length >= MAX_REFS} onClick={() => void pickFiles().then(addRefFiles)}>
                <ImagePlus className="h-3.5 w-3.5" /> Ảnh tham khảo
              </CtButton>
              <CtButton size="sm" variant={library ? "primary" : "outline"} onClick={() => void openLibrary()}>
                <Images className="h-3.5 w-3.5" /> Từ thư viện
              </CtButton>
              <span className="ml-2 text-[11px] text-muted-foreground">Tỉ lệ</span>
              <CtSelect<CtPackImageAspect> className="h-8 w-24" value={aspect} onChange={setAspect} options={PACK_ASPECTS.map((a) => ({ value: a, label: a }))} />
              {error && <span className="text-[11px] text-destructive">{error}</span>}
              <CtButton variant="primary" className="ml-auto" onClick={() => void send()} disabled={sending || (!description.trim() && !bases.some((b) => b.note.trim()))}>
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : agentOn ? <Send className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
                {agentOn ? "Gửi @flexiprint" : "Tạo ảnh"} <span className="text-[10px] opacity-70">⌘↵</span>
              </CtButton>
            </div>
          </div>
        </section>
      </div>
    </CtModal>
  );
}

/** One request and @flexiprint's answer, as two chat bubbles. */
function TaskTurn(p: {
  task: CtAgentTask;
  photos: CtPackImage[];
  card: (img: CtPackImage) => React.ReactNode;
  onAnswer: (questionId: string, choices: string[], text: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { task } = p;
  const pack = task.input.pack;
  const result = task.result as CtPackImageResult | null;
  return (
    <div className="space-y-2">
      {/* The editor */}
      <div className="ml-auto max-w-[80%] space-y-1.5 rounded-xl rounded-tr-sm bg-sky-500/10 p-2.5 text-xs">
        <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <User className="h-3 w-3" /> {new Date(task.created_at).toLocaleString("vi-VN")} · {pack?.aspect}
        </p>
        {packBases(pack).map((b, i) => (
          <div key={b.id} className="flex gap-1.5">
            <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded border" style={CHECKER_STYLE}>
              <img src={b.url} alt="" className="h-full w-full object-contain" />
              <span className="absolute left-0 top-0 rounded-br bg-black/70 px-0.5 text-[8px] text-white">{i + 1}</span>
            </span>
            <p className="min-w-0 flex-1 whitespace-pre-line">
              <b>Chỉnh:</b> {b.note || <span className="text-muted-foreground">theo yêu cầu chung</span>}
            </p>
          </div>
        ))}
        {pack?.description && <p className="whitespace-pre-line">{pack.description}</p>}
        {task.input.refUrls.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {task.input.refUrls.map((u) => (
              <img key={u} src={u} alt="" className="h-10 w-10 rounded border object-cover" />
            ))}
          </div>
        )}
      </div>
      {/* @flexiprint */}
      <div className="max-w-[95%] space-y-2 rounded-xl rounded-tl-sm border bg-background p-2.5 text-xs">
        <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <Bot className="h-3 w-3" /> @flexiprint
          {task.status === "cancelled" && " · đã dừng"}
        </p>
        {isOpen(task) && <AgentProgress task={task} onCancel={p.onCancel} onAnswer={p.onAnswer} />}
        {task.status === "done" && result?.summary && <p className="whitespace-pre-line">{result.summary}</p>}
        {task.status === "failed" && <p className="text-destructive">{task.error || "Agent không trả kết quả"}</p>}
        {p.photos.length > 0 && <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">{p.photos.map((img) => p.card(img))}</div>}
      </div>
    </div>
  );
}

/** A made photo: use it, keep editing it (pick several), edit its prompt and draw again, or drag it into the composer as a reference. */
function PhotoCard(p: { image: CtPackImage; selected: boolean; onUse: () => void; onEdit: () => void; onRedraw: (prompt: string) => Promise<void> }) {
  const { image } = p;
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState(image.prompt);
  const [busy, setBusy] = useState(false);
  const done = image.status === "done" && !!image.url;
  return (
    <div className={cx("space-y-1.5 rounded-lg border p-1.5", p.selected && "border-violet-500 ring-1 ring-violet-500")}>
      <button
        className="block aspect-square w-full overflow-hidden rounded disabled:cursor-default"
        style={CHECKER_STYLE}
        disabled={!done}
        onClick={p.onUse}
        draggable={done}
        onDragStart={(e) => {
          e.dataTransfer.setData(PHOTO_DRAG, image.url ?? "");
          e.dataTransfer.effectAllowed = "copy";
        }}
        title={done ? "Click: dùng ảnh này · Kéo xuống ô nhập: làm ảnh tham khảo" : undefined}
      >
        {done ? (
          <img src={image.url ?? ""} alt="" className="h-full w-full object-contain" />
        ) : image.status === "running" ? (
          <Loader2 className="m-auto h-5 w-5 animate-spin text-muted-foreground" />
        ) : (
          <X className="m-auto h-5 w-5 text-destructive" />
        )}
      </button>
      <p className="truncate text-[11px] font-medium" title={image.name}>
        {image.name}
      </p>
      {image.transparent && <span className="rounded bg-muted px-1 text-[10px]">nền trong suốt</span>}
      {image.status === "failed" && <p className="text-[11px] text-destructive">{image.error || "Tạo ảnh thất bại"}</p>}
      <div className="flex flex-wrap gap-1">
        {done && (
          <CtButton size="sm" variant="outline" className="h-6 px-1.5 text-[11px]" onClick={p.onUse}>
            <Check className="h-3 w-3" /> Dùng
          </CtButton>
        )}
        {done && (
          <CtButton size="sm" variant={p.selected ? "primary" : "outline"} className="h-6 px-1.5 text-[11px]" onClick={p.onEdit} title="Chọn nhiều ảnh, mỗi ảnh một yêu cầu riêng">
            <Wand2 className="h-3 w-3" /> {p.selected ? "Đã chọn" : "Chỉnh tiếp"}
          </CtButton>
        )}
        {image.prompt && (
          <CtButton size="sm" variant={editing ? "primary" : "ghost"} className="h-6 px-1.5 text-[11px]" onClick={() => setEditing(!editing)}>
            <Pencil className="h-3 w-3" /> Prompt
          </CtButton>
        )}
      </div>
      {editing && (
        <div className="space-y-1">
          <CtTextarea rows={6} className="text-[11px]" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
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
        </div>
      )}
    </div>
  );
}
