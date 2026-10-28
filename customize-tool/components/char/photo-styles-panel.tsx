"use client";

/**
 * "Style ảnh khách" of a bộ ảnh khách (step 3, asked 2026-10-28): the set's own AI styles — each card is one style the
 * customer picks on the store (its name + demo picture); the prompt and the style references stay on the server.
 * @flexiprint writes them from the brief ("4 kiểu: khăn choàng, siêu nhân áo choàng đỏ, dây đèn quấn quanh…") and tests
 * them; the editor tests them on their own photos here, fixes a prompt by hand, or drags a card into the chat to ask
 * for a change ("làm khăn dày hơn"). A test is made exactly like a customer's upload (the style, cut out).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, FlaskConical, GripVertical, ImagePlus, Loader2, Pencil, Plus, Star, Trash2, X } from "lucide-react";
import type { CtCharImage, CtCharPhotoStyle } from "../../types";
import { charApi } from "../../lib/api-client";
import { CHECKER_STYLE, CtButton, CtInput, CtTextarea, cx } from "../ui";
import type { CharCtx } from "./char-project";

const TEST_ROLE = "style:";

interface Draft {
  id?: string;
  name: string;
  prompt: string;
  refUrls: string[];
}

/** The newest test of each (style, photo). */
function testsOf(images: CtCharImage[], styleId: string): CtCharImage[] {
  const out = new Map<string, CtCharImage>();
  for (const im of images) if (im.role.startsWith(`${TEST_ROLE}${styleId}:`) && (!out.has(im.role) || out.get(im.role)!.created_at <= im.created_at)) out.set(im.role, im);
  return [...out.values()].sort((a, b) => a.role.localeCompare(b.role, undefined, { numeric: true }));
}

function Thumb({ url, className, alt = "" }: { url: string; className?: string; alt?: string }) {
  // eslint-disable-next-line @next/next/no-img-element -- our R2 pictures
  return <img src={url} alt={alt} className={cx("h-full w-full object-contain", className)} />;
}

export function PhotoStylesSection(ctx: CharCtx) {
  const { project, images, editable } = ctx;
  const zone = project.brief.photoZones[0];
  const [styles, setStyles] = useState<CtCharPhotoStyle[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState("");
  const photos = zone?.testPhotos ?? [];
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      setStyles(await charApi.photoStyles(project.id));
    } catch (e) {
      ctx.error(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ctx.error is stable enough; reload on brief / picture changes
  }, [project.id]);
  // The agent changes styles while it works: read them again when the zone or the pictures change.
  const zoneKey = JSON.stringify(zone?.styles ?? []);
  const doneCount = images.filter((im) => im.role.startsWith(TEST_ROLE) && im.status !== "running").length;
  useEffect(() => {
    void load();
  }, [load, zoneKey, doneCount, project.updated_at]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    ctx.error(null);
    try {
      await fn();
    } catch (e) {
      ctx.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  const save = () =>
    draft &&
    run("save", async () => {
      const r = await charApi.savePhotoStyle(project.id, draft);
      setStyles(r.styles);
      ctx.setProject(r.project);
      setDraft(null);
    });
  const remove = (st: CtCharPhotoStyle) =>
    confirm(`Bỏ style "${st.name}" khỏi bộ?`) &&
    run(`rm:${st.id}`, async () => {
      const r = await charApi.removePhotoStyle(project.id, st.id);
      setStyles(r.styles);
      ctx.setProject(r.project);
    });
  const test = (ids: string[]) =>
    run(ids.length === 1 ? `test:${ids[0]}` : "test", async () => {
      ctx.addImages(await charApi.testPhotoStyles(project.id, ids));
    });
  const demo = (st: CtCharPhotoStyle, im: CtCharImage) => run(`demo:${st.id}`, async () => setStyles(await charApi.styleDemo(project.id, st.id, im.id)));
  const move = (st: CtCharPhotoStyle, by: -1 | 1) => {
    const ids = styles.filter((x) => x.offered).map((x) => x.id);
    const i = ids.indexOf(st.id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void run("order", async () => {
      ctx.setProject(await charApi.orderPhotoStyles(project.id, ids));
    });
  };
  const upload = async (list: FileList | null): Promise<string[]> => {
    const files = [...(list ?? [])].filter((f) => f.type.startsWith("image/"));
    return Promise.all(files.map((f) => charApi.chatFile(project.id, f).then((r) => r.url)));
  };
  const addPhotos = (list: FileList | null) =>
    run("photos", async () => {
      const urls = await upload(list);
      if (urls.length) ctx.setProject(await charApi.styleTestPhotos(project.id, [...photos, ...urls]));
    });
  const dropPhoto = (url: string) => run("photos", async () => ctx.setProject(await charApi.styleTestPhotos(project.id, photos.filter((x) => x !== url))));

  if (!zone || zone.treat !== "ai") return null;
  const offered = styles.filter((x) => x.offered);
  const off = styles.filter((x) => !x.offered);
  return (
    <section className="space-y-4 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-[260px] flex-1">
          <h3 className="text-sm font-semibold">Style ảnh khách</h3>
          <p className="text-xs text-muted-foreground">
            Mỗi thẻ = 1 lựa chọn style trên store: khách upload ảnh, AI vẽ lại theo prompt của thẻ (ảnh 1 = ảnh khách, ảnh 2… = ảnh tham chiếu style). Kéo thẻ vào ô chat bên dưới để nhờ @flexiprint sửa prompt. Sửa prompt có hiệu lực ngay cho khách; tên / demo / thêm bớt style cần tạo lại sản phẩm rồi deploy lại.
          </p>
        </div>
        {editable && (
          <div className="flex gap-2">
            <CtButton size="sm" disabled={!!busy || !offered.length} onClick={() => void test([])}>
              {busy === "test" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />}
              Thử tất cả
            </CtButton>
            <CtButton size="sm" variant="primary" disabled={!!busy || !!draft} onClick={() => setDraft({ name: "", prompt: "", refUrls: [] })}>
              <Plus className="h-3.5 w-3.5" /> Style mới
            </CtButton>
          </div>
        )}
      </div>

      <div>
        <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Ảnh thử (như ảnh khách gửi — người hoặc thú cưng)</div>
        <div className="flex flex-wrap gap-2">
          {photos.map((u) => (
            <div key={u} className="group relative h-20 w-20 overflow-hidden rounded-md border bg-muted">
              <Thumb url={u} className="object-cover" />
              {editable && (
                <button className="absolute right-0.5 top-0.5 hidden rounded-full bg-black/60 p-0.5 text-white group-hover:block" onClick={() => void dropPhoto(u)} title="Bỏ ảnh thử">
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
          {!photos.length && <p className="self-center text-xs text-muted-foreground">Chưa có — thử trên ảnh thú cưng mẫu của hệ thống.</p>}
          {editable && photos.length < 6 && (
            <button className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-md border border-dashed text-[11px] text-muted-foreground hover:bg-accent" disabled={!!busy} onClick={() => fileRef.current?.click()}>
              {busy === "photos" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
              Thêm ảnh
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              void addPhotos(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      </div>

      {draft && !draft.id && <StyleForm draft={draft} setDraft={setDraft} save={save} saving={busy === "save"} upload={upload} />}

      <div className="grid gap-3 lg:grid-cols-2">
        {offered.map((st, i) =>
          draft?.id === st.id ? (
            <StyleForm key={st.id} draft={draft} setDraft={setDraft} save={save} saving={busy === "save"} upload={upload} />
          ) : (
            <StyleCard
              key={st.id}
              st={st}
              n={i + 1}
              total={offered.length}
              tests={testsOf(images, st.id)}
              photos={photos}
              editable={editable}
              busy={busy}
              onEdit={() => setDraft({ id: st.id, name: st.name, prompt: st.prompt, refUrls: st.refUrls })}
              onTest={() => void test([st.id])}
              onRemove={() => void remove(st)}
              onDemo={(im) => void demo(st, im)}
              onMove={(by) => move(st, by)}
            />
          ),
        )}
      </div>
      {!offered.length && !draft && (
        <p className="text-sm text-muted-foreground">
          Chưa có style nào. Viết ở chat, ví dụ: “4 style: đeo khăn choàng len, bộ đồ siêu nhân áo choàng đỏ, dây đèn trang trí quấn quanh, vẽ màu nước” — @flexiprint viết prompt, thử trên ảnh thử và chọn demo.
        </p>
      )}
      {off.length > 0 && (
        <div className="text-xs text-muted-foreground">
          Đã bỏ khỏi vùng ảnh: {off.map((x) => x.name).join(", ")}
        </div>
      )}
    </section>
  );
}

function StyleCard(props: {
  st: CtCharPhotoStyle;
  n: number;
  total: number;
  tests: CtCharImage[];
  photos: string[];
  editable: boolean;
  busy: string;
  onEdit: () => void;
  onTest: () => void;
  onRemove: () => void;
  onDemo: (im: CtCharImage) => void;
  onMove: (by: -1 | 1) => void;
}) {
  const { st, tests, editable, busy } = props;
  const [open, setOpen] = useState(false);
  const firstDone = tests.find((t) => t.status === "done");
  // What the card shows (and what a drag into the chat carries): the demo, else a test, else a style reference.
  const face = st.demoUrl || firstDone?.url || st.refUrls[0] || "";
  return (
    <div
      className="space-y-2 rounded-lg border bg-background p-3"
      draggable={!!face}
      data-chat-url={face || undefined}
      data-chat-label={`Style ảnh khách "${st.name}" (style_id ${st.id})`}
      title="Kéo thẻ vào ô chat để nhờ @flexiprint sửa style này"
    >
      <div className="flex items-start gap-3">
        <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-md border" style={CHECKER_STYLE}>
          {face ? <Thumb url={face} /> : <span className="flex h-full items-center justify-center px-1 text-center text-[10px] text-muted-foreground">chưa có demo</span>}
          {st.demoUrl && <span className="absolute left-1 top-1 rounded bg-amber-500 px-1 text-[9px] font-semibold text-white">DEMO</span>}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-1">
            <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-muted-foreground" />
            <span className="text-[11px] text-muted-foreground">#{props.n}</span>
            <span className="truncate text-sm font-semibold" title={st.name}>
              {st.name}
            </span>
            {!st.own && <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">thư viện</span>}
          </div>
          <button className={cx("w-full text-left text-[11px] leading-snug text-muted-foreground", !open && "line-clamp-3")} onClick={() => setOpen(!open)} title={open ? "Thu gọn" : "Xem cả prompt"}>
            {st.prompt}
          </button>
          {st.refUrls.length > 0 && (
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-muted-foreground">Tham chiếu:</span>
              {st.refUrls.map((u, i) => (
                <div key={u} className="h-8 w-8 overflow-hidden rounded border" style={CHECKER_STYLE} title={`Ảnh ${i + 2}`}>
                  <Thumb url={u} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {tests.map((t) => (
          <figure key={t.id} className="w-24">
            <div className="flex aspect-square items-center justify-center overflow-hidden rounded-md border" style={CHECKER_STYLE}>
              {t.status === "done" ? (
                <Thumb url={t.thumb_url || t.url} />
              ) : t.status === "running" ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : (
                <span className="px-1 text-center text-[10px] text-destructive" title={t.error}>
                  {t.error.slice(0, 80) || "lỗi"}
                </span>
              )}
            </div>
            <figcaption className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
              {(t.meta as { sourceUrl?: string }).sourceUrl && (
                <span className="h-4 w-4 overflow-hidden rounded-sm border">
                  <Thumb url={(t.meta as { sourceUrl: string }).sourceUrl} className="object-cover" />
                </span>
              )}
              <span className="flex-1">{t.created_at < st.updated_at ? "prompt cũ" : ""}</span>
              {editable && st.own && t.status === "done" && (
                <button className={cx("rounded p-0.5 hover:bg-accent", st.demoUrl === t.url && "text-amber-500")} onClick={() => props.onDemo(t)} title="Dùng làm ảnh demo (khách chọn style theo ảnh này)">
                  <Star className="h-3 w-3" />
                </button>
              )}
            </figcaption>
          </figure>
        ))}
        {!tests.length && <p className="text-[11px] text-muted-foreground">Chưa thử.</p>}
      </div>

      {editable && (
        <div className="flex flex-wrap items-center gap-1.5">
          <CtButton size="sm" disabled={!!busy} onClick={props.onTest}>
            {busy === `test:${st.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />}
            Thử
          </CtButton>
          {st.own && (
            <CtButton size="sm" variant="ghost" disabled={!!busy} onClick={props.onEdit}>
              <Pencil className="h-3.5 w-3.5" /> Sửa
            </CtButton>
          )}
          <span className="flex-1" />
          <CtButton size="icon" variant="ghost" disabled={!!busy || props.n === 1} onClick={() => props.onMove(-1)} title="Lên trước (style đầu = mặc định)">
            <ArrowUp className="h-3.5 w-3.5" />
          </CtButton>
          <CtButton size="icon" variant="ghost" disabled={!!busy || props.n === props.total} onClick={() => props.onMove(1)} title="Xuống sau">
            <ArrowDown className="h-3.5 w-3.5" />
          </CtButton>
          <CtButton size="icon" variant="ghost" disabled={!!busy} onClick={props.onRemove} title="Bỏ style">
            <Trash2 className="h-3.5 w-3.5" />
          </CtButton>
        </div>
      )}
    </div>
  );
}

function StyleForm(props: {
  draft: Draft;
  setDraft: (d: Draft | null) => void;
  save: () => void;
  saving: boolean;
  upload: (list: FileList | null) => Promise<string[]>;
}) {
  const { draft, setDraft } = props;
  const [adding, setAdding] = useState(false);
  const refFile = useRef<HTMLInputElement | null>(null);
  return (
    <div className="space-y-2 rounded-lg border border-sky-500/50 bg-background p-3">
      <CtInput placeholder="Tên style khách thấy (tiếng Anh), vd. Cozy Scarf" value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
      <CtTextarea
        rows={7}
        className="font-mono text-xs"
        placeholder={"Image 1 is the customer's photo (a pet or a person). Image 2 is the style reference artwork.\nRedraw ONLY the subject of image 1 … keep its real face … wearing … in EXACTLY the style of image 2.\nDO NOT draw any background, text or frame. Output: the subject only on a fully transparent background."}
        value={draft.prompt}
        onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
      />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-muted-foreground">Ảnh tham chiếu style (ảnh 2, 3…; tối đa 3):</span>
        {draft.refUrls.map((u) => (
          <div key={u} className="group relative h-12 w-12 overflow-hidden rounded border" style={CHECKER_STYLE}>
            <Thumb url={u} />
            <button className="absolute right-0 top-0 hidden rounded-full bg-black/60 p-0.5 text-white group-hover:block" onClick={() => setDraft({ ...draft, refUrls: draft.refUrls.filter((x) => x !== u) })}>
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        {draft.refUrls.length < 3 && (
          <button className="flex h-12 w-12 items-center justify-center rounded border border-dashed text-muted-foreground hover:bg-accent" onClick={() => refFile.current?.click()} disabled={adding}>
            {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
          </button>
        )}
        <input
          ref={refFile}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const list = e.target.files;
            setAdding(true);
            void props
              .upload(list)
              .then((urls) => setDraft({ ...draft, refUrls: [...draft.refUrls, ...urls].slice(0, 3) }))
              .finally(() => setAdding(false));
            e.target.value = "";
          }}
        />
      </div>
      <div className="flex justify-end gap-2">
        <CtButton size="sm" variant="ghost" onClick={() => setDraft(null)}>
          Huỷ
        </CtButton>
        <CtButton size="sm" variant="primary" disabled={props.saving || !draft.name.trim() || !draft.prompt.trim()} onClick={props.save}>
          {props.saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Lưu style
        </CtButton>
      </div>
    </div>
  );
}
