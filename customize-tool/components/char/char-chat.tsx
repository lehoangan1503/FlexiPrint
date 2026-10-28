"use client";

/**
 * The sticky chat at the bottom of a bộ nhân vật (asked 2026-10-12): the editor writes what they want on whichever tab
 * they are on — with screenshots (paste ⌘V, drop the macOS screenshot thumbnail, "Chụp màn hình") or pictures of the
 * page dragged in (a master, a 3b picture, a clipart file) — and it goes to @flexiprint as a "chat" task with the tab
 * and section it was written on. The agent gets the whole set over the MCP (server/mcp/char-tools.ts chatView) and
 * every char_* tool, like working with it in a terminal. Earlier requests and answers stay above the box.
 * While it works, the box "gửi chen" (asked 2026-10-22): the message goes into the task being worked on and the agent
 * reads it with its next tool call (server/agent/inbox.ts) — like the hand changes made in the editor meanwhile.
 * The thread is every task of the bộ from the first one (asked 2026-10-22: a reload lost it); folded, only the box
 * stays (remembered per browser).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Camera, ChevronDown, ChevronUp, ImagePlus, Loader2, MessageSquarePlus, Send, X } from "lucide-react";
import type { CtAgentTask, CtCharChatAttachment, CtCharChatTab, CtCharImage, CtCharProject, CtCharTaskStep } from "../../types";
import { charApi, ctApi } from "../../lib/api-client";
import { FLOAT_BTN, cx } from "../ui";
import { AgentProgress } from "../library/agent-brain";
import type { useCharAgent } from "./char-agent";

const TAB_LABEL: Record<CtCharChatTab, string> = { brief: "1. Mô tả bộ clipart", master: "2. Ảnh master", layers: "3. Cắt clipart", product: "4. Sản phẩm" };
const SECTION_LABEL: Record<string, string> = { "3a": "3a. Master cỡ in", "3b": "3b. AI vẽ ảnh để cắt", "3c": "3c. Bộ custom" };
/** A task that did not come from the box (a step button, the automatic run after the master). */
const STEP_TEXT: Record<CtCharTaskStep, string> = { brainstorm: "Brainstorm 3 hướng brief", master: "Vẽ master", edits: "Vẽ ảnh để cắt clipart (3b)", chat: "", auto: "Tự làm bước 3 – 4 (sau khi duyệt master)" };
const FOLD_KEY = "ct-char-chat-folded";
/** A picture dragged from the page carries this (set on dragstart below). */
const PAGE_PICTURE = "application/x-flexiprint-picture";

interface Pending extends CtCharChatAttachment {
  key: string;
  /** Local preview while it uploads. */
  preview: string;
  uploading: boolean;
  error: string;
}

/** What a url of the page is: one of the set's pictures, or one of its layer files. */
function describe(url: string, project: CtCharProject, images: CtCharImage[]): { imageId: string | null; label: string } {
  const masters = images.filter((im) => im.kind === "master");
  const im = images.find((x) => x.url === url || x.thumb_url === url);
  if (im) {
    if (im.kind === "master") return { imageId: im.id, label: `Master #${masters.indexOf(im) + 1}${im.id === project.master_id ? " (đã duyệt)" : ""}` };
    if (im.kind === "edit") return { imageId: im.id, label: `Ảnh 3b ${im.note || im.role}` };
    if (im.kind === "layer") {
      for (const sl of project.layers?.slots ?? [])
        for (const f of sl.files) if (f.imageId === im.id) return { imageId: im.id, label: `File ${sl.label}: ${[f.option, f.color].filter(Boolean).join(" · ")}` };
    }
    return { imageId: im.id, label: `${im.kind} ${im.note || im.role}`.trim() };
  }
  for (const sl of project.layers?.slots ?? [])
    for (const f of sl.files)
      if ([f.url, f.thumbUrl, f.viewUrl, f.viewThumbUrl].includes(url)) return { imageId: f.imageId, label: `File ${sl.label}: ${[f.option, f.color].filter(Boolean).join(" · ")}${f.viewUrl === url || f.viewThumbUrl === url ? " (ảnh đại diện)" : ""}` };
  const m = project.cut?.matte;
  if (m && (m.colourUrl === url || m.previewUrl === url)) return { imageId: null, label: "Master cỡ in (3a)" };
  for (const pic of project.cut?.plan?.pictures ?? []) if (pic.colourUrl === url || pic.previewUrl === url) return { imageId: null, label: `Ảnh 3c: ${pic.label}` };
  for (const pc of project.cut?.plan?.pieces ?? []) if (pc.region.url === url) return { imageId: null, label: `Vùng 3c: ${pc.label}` };
  return { imageId: null, label: "Ảnh trên trang" };
}

/** One frame of a screen / window / tab the editor picks (the browser asks). */
async function grabScreen(): Promise<Blob> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  try {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await new Promise((r) => setTimeout(r, 250));
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")!.drawImage(video, 0, 0);
    return await new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error("Không chụp được"))), "image/png"));
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

export function CharChat(props: {
  project: CtCharProject;
  images: CtCharImage[];
  tab: CtCharChatTab;
  section: string;
  editable: boolean;
  kit: ReturnType<typeof useCharAgent>;
  flush: () => Promise<void>;
}) {
  const { project, images, tab, section, kit } = props;
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Pending[]>([]);
  const [history, setHistory] = useState<CtAgentTask[]>([]);
  // Folded: only the box shows (the choice stays in this browser).
  const [folded, setFolded] = useState(() => {
    try {
      return localStorage.getItem(FOLD_KEY) === "1";
    } catch {
      return false;
    }
  });
  const fold = (v: boolean) => {
    setFolded(v);
    try {
      localStorage.setItem(FOLD_KEY, v ? "1" : "0");
    } catch {
      /* remembered only while the page is open */
    }
  };
  const thread = useRef<HTMLDivElement | null>(null);
  const [over, setOver] = useState(false);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState("");
  const box = useRef<HTMLTextAreaElement | null>(null);
  const ctx = useRef({ project, images });
  useEffect(() => {
    ctx.current = { project, images };
  }, [project, images]);

  const task = kit.agent.task;
  const loadHistory = useCallback(async () => {
    try {
      const list = await ctApi.listAgentTasks("char", project.id);
      setHistory([...list].reverse());
    } catch {
      /* the thread is a convenience */
    }
  }, [project.id]);
  useEffect(() => {
    void loadHistory();
  }, [loadHistory, task?.id, kit.agent.last?.id]);

  // Any picture of the page dragged anywhere: it says what it is (the drop below reads it).
  useEffect(() => {
    const onDragStart = (e: DragEvent) => {
      if (!e.dataTransfer || !(e.target instanceof Element)) return;
      // A clipart tile (a background-image div) says its file; a plain <img> is itself.
      const tile = e.target.closest<HTMLElement>("[data-chat-url]");
      const img = e.target instanceof HTMLImageElement ? e.target : null;
      const url = tile?.dataset.chatUrl || (img ? img.currentSrc || img.src : "");
      if (!url) return;
      if (tile && !img) e.dataTransfer.setData("text/uri-list", url);
      // A card that says what it is (a style ảnh khách card: its name and id) keeps that label.
      const label = tile?.dataset.chatLabel;
      e.dataTransfer.setData(PAGE_PICTURE, JSON.stringify({ url, ...describe(url, ctx.current.project, ctx.current.images), ...(label ? { label } : {}) }));
    };
    document.addEventListener("dragstart", onDragStart, true);
    return () => document.removeEventListener("dragstart", onDragStart, true);
  }, []);

  const addBlob = (blob: Blob, source: "screenshot" | "file", label: string) => {
    const key = crypto.randomUUID();
    const preview = URL.createObjectURL(blob);
    setFiles((cur) => [...cur, { key, preview, url: "", imageId: null, label, source, uploading: true, error: "" }]);
    charApi
      .chatFile(project.id, blob)
      .then((r) => setFiles((cur) => cur.map((f) => (f.key === key ? { ...f, url: r.url, uploading: false } : f))))
      .catch((e: Error) => setFiles((cur) => cur.map((f) => (f.key === key ? { ...f, uploading: false, error: e.message } : f))));
    box.current?.focus();
  };

  const addPage = (url: string, imageId: string | null, label: string) => {
    setFiles((cur) => (cur.some((f) => f.url === url) ? cur : [...cur, { key: crypto.randomUUID(), preview: url, url, imageId, label, source: "page", uploading: false, error: "" }]));
    box.current?.focus();
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setOver(false);
    const page = e.dataTransfer.getData(PAGE_PICTURE);
    if (page) {
      const p = JSON.parse(page) as { url: string; imageId: string | null; label: string };
      addPage(p.url, p.imageId, p.label);
      return;
    }
    const list = [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"));
    if (list.length) {
      for (const f of list) addBlob(f, /screen ?shot|ảnh chụp/i.test(f.name) ? "screenshot" : "file", /screen ?shot|ảnh chụp/i.test(f.name) ? "Ảnh chụp màn hình" : f.name);
      return;
    }
    const url = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
    if (/^https?:\/\//.test(url)) addPage(url, ...(Object.values(describe(url, project, images)) as [string | null, string]));
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const list = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
    if (!list.length) return;
    e.preventDefault();
    for (const f of list) addBlob(f, "screenshot", "Ảnh chụp màn hình");
  };

  const capture = async () => {
    setErr("");
    try {
      addBlob(await grabScreen(), "screenshot", "Ảnh chụp màn hình");
    } catch (e) {
      if (e instanceof Error && e.name !== "NotAllowedError") setErr(e.message);
    }
  };

  const ready = files.every((f) => !f.uploading && !f.error);
  // The agent at work (not waiting on a question of its own): a message goes into that task.
  const injecting = !!task && (task.status === "running" || task.status === "pending");
  const send = async () => {
    if (!text.trim() && !files.length) return;
    if (kit.agent.busy && !injecting) return;
    setSending(true);
    setErr("");
    try {
      await props.flush();
      const attachments: CtCharChatAttachment[] = files.map(({ url, imageId, label, source }) => ({ url, imageId, label, source }));
      const ok = injecting ? await kit.inject(text.trim(), { tab, section, attachments }) : await kit.agent.start("chat", text.trim(), { tab, section, attachments });
      if (ok) {
        files.forEach((f) => f.source !== "page" && URL.revokeObjectURL(f.preview));
        setText("");
        setFiles([]);
      }
    } finally {
      setSending(false);
    }
  };

  const where = `${project.brief.kind === "photo" && tab === "layers" ? "3. Phần tử" : TAB_LABEL[tab]}${section ? ` → ${SECTION_LABEL[section] ?? section}` : ""}`;
  const live = task;
  const turns = live && !history.some((t) => t.id === live.id) ? [...history, live] : history;
  // The newest at the bottom, in view (as it grows too).
  const lastLines = live?.progress?.length ?? 0;
  useEffect(() => {
    const el = thread.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, lastLines, folded]);
  return (
    <div
      className={cx("sticky bottom-0 z-30 border-t bg-card/95 shadow-[0_-4px_16px_rgba(0,0,0,0.08)] backdrop-blur", over && "ring-2 ring-inset ring-violet-500")}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      {!folded && turns.length > 0 && (
        <div ref={thread} className="max-h-[55vh] space-y-3 overflow-y-auto border-b px-4 py-3 text-sm">
          <div className="text-center text-[11px] text-muted-foreground">Toàn bộ trao đổi với @flexiprint của bộ này ({turns.length})</div>
          {turns.map((t) => (
            <ChatTurn key={t.id} task={t} live={live?.id === t.id ? live : null} kit={kit} />
          ))}
        </div>
      )}
      <div className="flex items-end gap-2 px-4 py-2">
        <button
          className="mb-1 flex flex-col items-center rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-accent disabled:opacity-40"
          disabled={!turns.length}
          onClick={() => fold(!folded)}
          title={folded ? `Mở rộng: xem cả ${turns.length} lượt từ đầu` : "Thu gọn: chỉ để lại ô chat"}
        >
          {folded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          {folded ? "Mở rộng" : "Thu gọn"}
        </button>
        <div className="min-w-0 flex-1 rounded-lg border bg-background">
          <div className="flex flex-wrap items-center gap-1.5 px-2 pt-1.5 text-[11px] text-muted-foreground">
            <Bot className="h-3.5 w-3.5 text-violet-500" />
            <span>
              @flexiprint · đang ở <b className="text-foreground">{where}</b>
            </span>
            {live && (
              <span className="flex items-center gap-1 text-violet-600">
                <Loader2 className="h-3 w-3 animate-spin" /> đang làm
              </span>
            )}
          </div>
          {files.length > 0 && (
            <div className="flex flex-wrap gap-2 px-2 pt-2">
              {files.map((f) => (
                <figure key={f.key} className="group relative h-16 w-16 overflow-hidden rounded border bg-[repeating-conic-gradient(#e5e5e5_0%_25%,#fff_0%_50%)] bg-[length:12px_12px]" title={f.label}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- local preview / our R2 picture */}
                  <img src={f.preview} alt={f.label} className="h-full w-full object-contain" draggable={false} />
                  {f.uploading && <Loader2 className="absolute inset-0 m-auto h-4 w-4 animate-spin text-violet-600" />}
                  {f.error && <span className="absolute inset-x-0 bottom-0 bg-destructive/90 px-0.5 text-[9px] text-white">lỗi</span>}
                  <figcaption className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-0.5 text-[9px] text-white">{f.label}</figcaption>
                  <button className={`absolute right-0.5 top-0.5 hidden p-0.5 group-hover:block ${FLOAT_BTN}`} onClick={() => setFiles((cur) => cur.filter((x) => x.key !== f.key))} title="Bỏ">
                    <X className="h-3 w-3" />
                  </button>
                </figure>
              ))}
            </div>
          )}
          <textarea
            ref={box}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (ready && !sending && (!kit.agent.busy || injecting)) void send();
              }
            }}
            rows={Math.min(8, Math.max(2, text.split("\n").length))}
            disabled={!props.editable}
            placeholder={
              !props.editable
                ? "Chỉ xem — bộ của người khác"
                : injecting
                  ? "@flexiprint đang làm — gõ để GỬI CHEN: nó đọc ngay ở bước kế tiếp và đổi việc đang làm theo (sửa tay trên editor nó cũng được báo). Enter gửi chen."
                  : tab === "brief" && !project.master_id
                  ? "Mô tả bộ clipart cho @flexiprint: sản phẩm gì, nhân vật nào, khách đổi được gì, chữ gì… — kéo ảnh mẫu / ảnh tham khảo vào đây (hoặc ⌘V). Enter gửi, Shift+Enter xuống dòng."
                  : `Yêu cầu cho @flexiprint ở ${where} — dán ảnh chụp màn hình (⌘V), kéo ảnh / clipart của trang vào đây. Enter gửi, Shift+Enter xuống dòng.`
            }
            className="block w-full resize-none bg-transparent px-2 py-1.5 text-sm"
            // Inline: the app's unlayered `*:focus-visible` outline beats Tailwind's layered utilities.
            style={{ outline: "none", border: "none", boxShadow: "none" }}
          />
        </div>
        <div className="mb-1 flex flex-col gap-1">
          <label className="cursor-pointer rounded p-1.5 text-muted-foreground hover:bg-accent" title="Thêm ảnh từ máy">
            <ImagePlus className="h-4 w-4" />
            <input
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                for (const f of [...(e.target.files ?? [])]) addBlob(f, "file", f.name);
                e.target.value = "";
              }}
            />
          </label>
          <button className="rounded p-1.5 text-muted-foreground hover:bg-accent" onClick={() => void capture()} title="Chụp màn hình (chọn tab / cửa sổ)">
            <Camera className="h-4 w-4" />
          </button>
        </div>
        <button
          className={cx("mb-1 flex h-9 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm font-medium text-white disabled:opacity-50", injecting ? "bg-amber-600 hover:bg-amber-700" : "bg-violet-600 hover:bg-violet-700")}
          disabled={!props.editable || sending || (kit.agent.busy && !injecting) || !ready || (!text.trim() && !files.length)}
          onClick={() => void send()}
          title={injecting ? "Chen vào việc @flexiprint đang làm — nó đọc ở lần gọi tool kế tiếp (Enter)" : kit.agent.busy ? "@flexiprint đang chờ bạn trả lời câu hỏi ở trên" : "Gửi (Enter)"}
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : injecting ? <MessageSquarePlus className="h-4 w-4" /> : <Send className="h-4 w-4" />} {injecting ? "Gửi chen" : "Gửi"}
        </button>
      </div>
      {err && <p className="px-4 pb-2 text-xs text-destructive">{err}</p>}
    </div>
  );
}

/** One request of the thread: what the editor wrote (and sent), then what the agent did / answered. */
function ChatTurn({ task, live, kit }: { task: CtAgentTask; live: CtAgentTask | null; kit: ReturnType<typeof useCharAgent> }) {
  const c = task.input.char;
  const t = live ?? task;
  const summary = t.result && "summary" in t.result ? String(t.result.summary) : "";
  const fromBox = c?.step === "chat";
  // What was sent in while it ran ("Gửi chen"): kept in the task's log.
  const injected = live ? [] : (t.progress ?? []).filter((l) => l.kind === "inject");
  return (
    <div className="space-y-1.5">
      <div className={cx("ml-auto max-w-[80%] rounded-lg px-3 py-2", fromBox ? "bg-violet-500/10" : "border border-dashed bg-muted/40")}>
        <div className="mb-0.5 text-[10px] text-muted-foreground">
          {fromBox ? (c?.tab ? TAB_LABEL[c.tab] : "") : "Nút trên trang"}
          {fromBox && c?.section ? ` → ${SECTION_LABEL[c.section] ?? c.section}` : ""} · {new Date(task.created_at).toLocaleString("vi-VN")}
        </div>
        {!fromBox && c && <p className="font-medium">{STEP_TEXT[c.step]}</p>}
        {c?.request && <p className="whitespace-pre-wrap">{c.request}</p>}
        {!!c?.attachments?.length && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {c.attachments.map((a) => (
              <a key={a.url} href={a.url} target="_blank" rel="noreferrer" title={a.label}>
                {/* eslint-disable-next-line @next/next/no-img-element -- our R2 picture */}
                <img src={a.url} alt={a.label} className="h-12 w-12 rounded border object-contain" />
              </a>
            ))}
          </div>
        )}
      </div>
      {injected.map((l) => (
        <div key={l.at} className="ml-auto max-w-[80%] rounded-lg bg-amber-500/10 px-3 py-2">
          <div className="mb-0.5 text-[10px] text-muted-foreground">Gửi chen · {new Date(l.at).toLocaleString("vi-VN")}</div>
          <p className="whitespace-pre-wrap">{l.text.replace(/^Bạn gửi chen: /, "")}</p>
          {!!l.images?.length && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {l.images.map((u) => (
                // eslint-disable-next-line @next/next/no-img-element -- our R2 picture
                <img key={u} src={u} alt="" className="h-12 w-12 rounded border object-contain" />
              ))}
            </div>
          )}
        </div>
      ))}
      <div className="max-w-[85%] rounded-lg border bg-background px-3 py-2">
        {live ? (
          <AgentProgress task={live} onCancel={() => void kit.cancel()} onAnswer={kit.answer} />
        ) : t.status === "done" ? (
          <p className="whitespace-pre-wrap">{summary || "Xong."}</p>
        ) : (
          <p className="text-destructive">{t.status === "cancelled" ? "Đã dừng." : t.error || "Agent không trả kết quả."}</p>
        )}
      </div>
    </div>
  );
}
