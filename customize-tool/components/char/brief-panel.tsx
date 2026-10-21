"use client";

/**
 * Step 1 — the brief, read only (asked 2026-10-19: "bỏ hết cái bước nhập le te lăng nhăng"): the editor writes
 * EVERYTHING in the chat at the bottom of the page — what they want in their own words, with the reference pictures
 * (a sample product, a style…) dropped or pasted in — and @flexiprint turns it into the brief (product, characters and
 * what the customer changes, versions, texts, decorations, mockups) and draws the masters. This step shows what it
 * understood, for review; a change is asked in the same chat.
 */

import { useState } from "react";
import { ArrowRight, Eye, ImagePlus, Layers, MessageSquare, Shirt, Type, Users } from "lucide-react";
import type { CtCharBrief, CtCharSlot } from "../../types";
import { CHAR_ELEMENT_PLACE_LABEL, ELEMENT_PLACE_LABEL, REF_USE_INFO, briefCombos } from "../../lib/char-brief";
import { charVersions } from "../../lib/char-lineup";
import { CtButton, CtModal, cx } from "../ui";
import type { CharCtx } from "./char-project";
import { StepGuide } from "./step-guide";

const MODE_LABEL: Record<CtCharSlot["mode"], string> = { color: "đổi màu", texture: "đổi chất liệu", shape: "đổi kiểu" };
const PLACE_LABEL: Record<string, string> = { top: "trên", bottom: "dưới", left: "trái", right: "phải", under: "dưới 1 nhân vật", free: "ô riêng", on: "trên nón / áo 1 nhân vật", plaque: "trên biển gỗ" };
const KIND_LABEL: Record<CtCharBrief["kind"], string> = { character: "Bộ nhân vật (AI vẽ nhân vật, khách phối)", photo: "Bộ ảnh khách (ảnh khách là nhân vật chính)" };

/** What the editor writes in the chat for a new set (shown while the brief is empty). */
const EXAMPLE =
  "Làm ornament acrylic cắt viền giống ảnh mẫu: bà ở giữa, 1–4 cháu hai bên, chống cằm lên biển gỗ \"This Grandma Belongs To\" (biển chỉ 1/4 chiều cao). Mỗi nhân vật vẽ riêng theo dáng (cháu bên phải lật gương), rồi ghép thành bản 1–4 cháu. 3 theme Giáng sinh / Halloween / Phục sinh đổi nón, áo, biển. Cháu: 2 kiểu tóc nam, 2 kiểu tóc nữ; bà 2 kiểu tóc; mỗi kiểu 3 màu; 3 biểu cảm cho mọi người. Tên mỗi người trên vành nón.";

export function BriefPanel(ctx: CharCtx) {
  const { project, images } = ctx;
  const brief = project.brief;
  const [preview, setPreview] = useState(false);
  const empty = brief.kind === "photo" ? !brief.photoZones.length : !brief.subjects.length;
  const refs = brief.refs.map((r) => ({ r, im: images.find((x) => x.id === r.id && x.status === "done") })).filter((x) => x.im);
  return (
    <div className="min-w-0 space-y-6 p-6">
      <StepGuide title="Bước 1 — mô tả bộ clipart: viết hết vào ô chat ở dưới cùng">
        <p>Không còn ô nhập nào ở đây. Mọi thứ gom về một chỗ — ô chat @flexiprint ở cuối trang:</p>
        <ul className="list-disc space-y-0.5 pl-4">
          <li>
            <ImagePlus className="inline h-3.5 w-3.5 align-[-2px]" /> <b>Ảnh tham khảo</b>: kéo ảnh sản phẩm mẫu vào ô chat, dán (⌘V), hoặc bấm nút thêm ảnh.
          </li>
          <li>
            <MessageSquare className="inline h-3.5 w-3.5 align-[-2px]" /> <b>Mô tả</b>: sản phẩm gì, ai trong tranh, khách đổi được gì (tóc, màu, biểu cảm, theme, số người), chữ gì, nằm đâu.
          </li>
          <li>
            Bấm <b>Gửi</b>: @flexiprint xem ảnh, viết brief bên dưới, rồi vẽ master ở bước 2. Muốn sửa gì cũng gõ tiếp vào ô chat.
          </li>
        </ul>
      </StepGuide>

      {empty ? (
        <div className="rounded-xl border border-dashed p-6 text-sm">
          <p className="font-medium">Chưa có brief.</p>
          <p className="mt-1 text-muted-foreground">Ví dụ một yêu cầu (kèm ảnh mẫu) gõ vào ô chat:</p>
          <p className="mt-2 rounded-md bg-muted/50 p-3 text-xs italic">{EXAMPLE}</p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-muted px-2 py-0.5 text-xs">{KIND_LABEL[brief.kind]}</span>
            {brief.kind !== "photo" && <span className="rounded bg-muted px-2 py-0.5 text-xs">{briefCombos(brief).toLocaleString("vi-VN")} tổ hợp</span>}
            {project.master_id && <span className="rounded bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">Master đã duyệt — phần nhân vật bị khoá (chữ, nền, mockup vẫn đổi được qua chat)</span>}
            <CtButton size="sm" className="ml-auto" onClick={() => setPreview(true)}>
              <Eye className="h-4 w-4" /> Xem trước như trang sản phẩm
            </CtButton>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card icon={<Layers className="h-4 w-4" />} title="Sản phẩm & phong cách">
              <Row k="Sản phẩm" v={[brief.product.label, brief.product.widthMm && brief.product.heightMm ? `${brief.product.widthMm}×${brief.product.heightMm} mm` : "", brief.product.cut === "alpha" ? "cắt viền" : brief.product.cut === "frame" ? "khuôn cố định" : ""].filter(Boolean).join(" · ")} />
              <Row k="Phong cách" v={brief.style} />
              {brief.kind !== "photo" && <Row k="Bố cục" v={[brief.framing === "bust" ? "nửa người (sau biển)" : "cả người", brief.scene].filter(Boolean).join(" — ")} />}
              {refs.length > 0 && (
                <div className="flex flex-wrap gap-2 pt-1">
                  {refs.map(({ r, im }) => (
                    <figure key={r.id} className="w-24" title={r.note}>
                      {/* eslint-disable-next-line @next/next/no-img-element -- our R2 picture */}
                      <img src={im!.thumb_url || im!.url} alt="" className="h-24 w-24 rounded border object-cover" />
                      <figcaption className="mt-0.5 truncate text-[10px] text-muted-foreground">{REF_USE_INFO[r.use].label}</figcaption>
                    </figure>
                  ))}
                </div>
              )}
            </Card>
            {brief.kind !== "photo" && (
              <Card icon={<Users className="h-4 w-4" />} title="Phiên bản & lựa chọn chung">
                {brief.lineup && brief.subjects.length > 1 ? (
                  <Row
                    k={brief.lineup.label}
                    v={`${charVersions(brief)
                      .map((v) => v.name)
                      .join(" · ")}${brief.lineup.drawn ? " — mỗi phiên bản vẽ một ảnh riêng" : ""}`}
                  />
                ) : (
                  <Row k="Phiên bản" v="Một (mọi nhân vật luôn có)" />
                )}
                {(brief.choosers ?? []).map((c) => (
                  <Row key={c.id} k={c.label} v={c.options.map((o) => o.name).join(" · ")} />
                ))}
                {brief.elements.map((e) => (
                  <Row key={e.id} k={`${e.name} (${(brief.kind === "photo" ? ELEMENT_PLACE_LABEL : CHAR_ELEMENT_PLACE_LABEL)[e.place]})`} v={`${e.options.map((o) => o.name).join(" · ")}${e.follows ? ` — theo ${e.follows}` : ""}`} />
                ))}
              </Card>
            )}
          </div>
          {brief.kind !== "photo" && (
            <Card icon={<Shirt className="h-4 w-4" />} title={`Nhân vật (${brief.subjects.length}) — khách đổi được`}>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {brief.subjects.map((sub, i) => (
                  <div key={sub.id} className="rounded-lg border p-3">
                    <div className="text-sm font-medium">
                      {i + 1}. {sub.name || sub.description.split(/[,.;]/)[0]}
                      {sub.always && <span className="ml-1 text-[10px] text-muted-foreground">(luôn có)</span>}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{sub.description}</p>
                    <ul className="mt-2 space-y-1.5">
                      {sub.slots.map((sl) => (
                        <li key={sl.id} className="text-xs">
                          <span className="font-medium">{sl.part}</span> <span className="text-muted-foreground">· {MODE_LABEL[sl.mode]}{sl.group ? " · vẽ chung" : ""}{sl.on ? " · vẽ dưới nón" : ""}{sl.follows ? ` · theo ${sl.follows}` : ""}</span>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1">
                            {sl.options.map((o) =>
                              sl.mode === "color" ? (
                                <span key={o.id} title={o.name} className="h-4 w-4 rounded-full border" style={{ backgroundColor: /^#[0-9a-f]{6}$/i.test(o.value) ? o.value : "#ccc" }} />
                              ) : (
                                <span key={o.id} className="rounded border px-1.5 py-0.5 text-[10px]">
                                  {o.name}
                                </span>
                              ),
                            )}
                            {sl.colors.map((c) => (
                              <span key={c.id} title={c.name} className="h-4 w-4 rounded-full border" style={{ backgroundColor: /^#[0-9a-f]{6}$/i.test(c.value) ? c.value : "#ccc" }} />
                            ))}
                          </div>
                        </li>
                      ))}
                      {!sub.slots.length && <li className="text-xs text-muted-foreground">Không có phần đổi.</li>}
                    </ul>
                  </div>
                ))}
              </div>
            </Card>
          )}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card icon={<Type className="h-4 w-4" />} title="Chữ cá nhân hoá">
              {brief.texts.map((t) => (
                <Row key={t.id} k={t.label} v={`${t.kind === "input" ? "khách gõ" : t.kind === "choice" ? "khách chọn" : "cố định"}: "${t.kind === "choice" ? t.choices[0] : t.defaultText}" · ${PLACE_LABEL[t.place] ?? t.place} · ${t.font}`} />
              ))}
              {!brief.texts.length && <p className="text-xs text-muted-foreground">Không có chữ.</p>}
            </Card>
            <Card icon={<ImagePlus className="h-4 w-4" />} title="Nền & mockup">
              {brief.backdrops.map((b) => (
                <Row key={b.id} k={b.name} v={b.value} />
              ))}
              {!brief.backdrops.length && <Row k="Nền" v="Không (màu / chất liệu của phôi)" />}
              {brief.mockups.map((m, i) => (
                <Row key={i} k={`Mockup ${i + 1}`} v={m} />
              ))}
            </Card>
          </div>
          <div className="flex justify-end">
            <CtButton variant="primary" onClick={() => ctx.goto("master")}>
              Sang bước 2 · Ảnh master <ArrowRight className="h-4 w-4" />
            </CtButton>
          </div>
        </>
      )}
      <CtModal open={preview} onOpenChange={setPreview} title="Xem trước — các option khách chọn" wide keepOpenOnOutside={false}>
        <OptionsPreview ctx={ctx} />
      </CtModal>
    </div>
  );
}

function Card({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 rounded-xl border bg-card p-4">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold">
        {icon} {title}
      </h3>
      {children}
    </section>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  if (!v) return null;
  return (
    <div className="grid grid-cols-[140px_1fr] gap-2 text-xs">
      <span className="text-muted-foreground">{k}</span>
      <span className={cx("whitespace-pre-wrap")}>{v}</span>
    </div>
  );
}

/**
 * "Xem trước" of the custom options: the master on the left (the approved one, else the newest), on the right every
 * option the customer will pick, laid out like the product page. Only the background can be clicked (asked
 * 2026-10-19): once step 4 has drawn it, the master is shown on it (multiply — the master's white drops out).
 */
function OptionsPreview({ ctx }: { ctx: CharCtx }) {
  const { project, images } = ctx;
  const brief = project.brief;
  const masters = images.filter((im) => im.kind === "master" && im.status === "done");
  const master = masters.find((im) => im.id === project.master_id) ?? [...masters].reverse().find((im) => im.role === "master") ?? [...masters].reverse()[0] ?? null;
  const [backdropId, setBackdropId] = useState<string | null>(brief.backdrops[0]?.id ?? null);
  const backdropPic = (id: string) => [...images].reverse().find((im) => im.kind === "blank" && im.role === `backdrop:${id}` && im.status === "done") ?? null;
  const shownBackdrop = backdropId ? backdropPic(backdropId) : null;
  const short = (d: string) => {
    const t = d.split(/[,.;]/)[0].trim();
    return t ? t[0].toUpperCase() + t.slice(1) : "";
  };
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div
        className="flex aspect-square items-center justify-center self-start overflow-hidden rounded-xl border bg-white bg-cover bg-center lg:sticky lg:top-20"
        style={shownBackdrop ? { backgroundImage: `url(${shownBackdrop.thumb_url || shownBackdrop.url})` } : undefined}
      >
        {master ? (
          // eslint-disable-next-line @next/next/no-img-element -- our R2 preview
          <img src={master.thumb_url || master.url} alt="master" className={cx("h-full w-full object-contain", shownBackdrop && "mix-blend-multiply")} />
        ) : (
          <span className="p-6 text-center text-sm text-muted-foreground">Chưa có master — sang bước 2 để vẽ.</span>
        )}
      </div>
      <div className="space-y-4 rounded-xl border bg-[#f6f3ee] p-4 text-[#1d1d1f]">
        <div className="rounded-md bg-gradient-to-r from-[#d9814a] to-transparent px-3 py-2 text-sm font-semibold text-white">Personalized</div>
        {brief.lineup && brief.subjects.length > 1 && (
          <div className="space-y-1.5">
            <div className="text-sm font-medium">
              {brief.lineup.label} <span className="text-[#c0392b]">*</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {/* The product's own versions (the grandma always there is not counted: 1–4 grandchildren). */}
              {charVersions(brief).map((v, i) => (
                <span key={v.name || i} className={cx("rounded-md border bg-white px-2.5 py-1 text-xs", i === 0 && "border-[#d9814a] ring-1 ring-[#d9814a]")}>
                  {v.name}
                </span>
              ))}
            </div>
          </div>
        )}
        {brief.subjects.map((sub, i) => (
          <div key={sub.id} className="space-y-3">
            {sub.slots.length > 0 && <div className="text-xs font-semibold uppercase tracking-wide text-[#8a7f73]">{sub.name || short(sub.description) || `Option ${i + 1}`}</div>}
            {sub.slots.map((slot) => (
              <div key={slot.id} className="space-y-1.5">
                <div className="text-sm font-medium">
                  Choose {slot.part || "option"} <span className="text-[#c0392b]">*</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {slot.optional && <span className="rounded-md border bg-white px-2.5 py-1 text-xs font-semibold text-[#d9814a]">NO</span>}
                  {slot.options.map((o, j) =>
                    slot.mode === "color" ? (
                      <span key={o.id} title={o.name} className={cx("h-8 w-8 rounded-full border-2", j === 0 ? "border-[#d9814a]" : "border-white shadow")} style={{ backgroundColor: /^#[0-9a-f]{6}$/i.test(o.value) ? o.value : "#cccccc" }} />
                    ) : (
                      <span key={o.id} className={cx("rounded-md border bg-white px-2.5 py-1 text-xs", j === 0 && "border-[#d9814a] ring-1 ring-[#d9814a]")}>
                        {o.name || "(chưa tên)"}
                      </span>
                    ),
                  )}
                </div>
                {slot.mode === "shape" && slot.colors.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pl-1">
                    {slot.colors.map((c, j) => (
                      <span key={c.id} title={c.name} className={cx("h-6 w-6 rounded-full border-2", j === 0 ? "border-[#d9814a]" : "border-white shadow")} style={{ backgroundColor: /^#[0-9a-f]{6}$/i.test(c.value) ? c.value : "#cccccc" }} />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
        {brief.elements
          .filter((e) => !e.follows && !e.perBackdrop && e.options.length > 1)
          .map((e) => (
            <div key={e.id} className="space-y-1.5">
              <div className="text-sm font-medium">{e.name}</div>
              <div className="flex flex-wrap gap-1.5">
                {e.options.map((o, j) => (
                  <span key={o.id} className={cx("rounded-md border bg-white px-2.5 py-1 text-xs", j === 0 && "border-[#d9814a] ring-1 ring-[#d9814a]")}>
                    {o.name}
                  </span>
                ))}
              </div>
            </div>
          ))}
        {brief.photoZones.map((z) => (
          <div key={z.id} className="space-y-1.5">
            <div className="text-sm font-medium">{z.label || "Upload your photo"}</div>
            <span className="inline-flex rounded-md border border-dashed bg-white px-3 py-2 text-xs text-[#8a7f73]">Upload photo</span>
          </div>
        ))}
        <div className="space-y-1.5">
          <div className="text-sm font-medium">
            Background {brief.backdrops.length > 0 && <span className="text-[#c0392b]">*</span>}
          </div>
          {brief.backdrops.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {brief.backdrops.map((b) => {
                const pic = backdropPic(b.id);
                return (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => setBackdropId(b.id)}
                    className={cx("flex items-center gap-1.5 rounded-md border bg-white py-1 pl-1 pr-2.5 text-xs", backdropId === b.id && "border-[#d9814a] ring-1 ring-[#d9814a]")}
                  >
                    {pic ? (
                      // eslint-disable-next-line @next/next/no-img-element -- our R2 preview
                      <img src={pic.thumb_url || pic.url} alt="" className="h-6 w-6 rounded object-cover" />
                    ) : (
                      <span className="h-6 w-6 rounded bg-[#e8e2d8]" />
                    )}
                    {b.name || "(chưa tên)"}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-[#8a7f73]">Chưa có nền — thêm ở mục “Nền & mockup” bên dưới (không có nền = màu phôi).</p>
          )}
          {brief.backdrops.length > 0 && !brief.backdrops.some((b) => backdropPic(b.id)) && <p className="text-[11px] text-[#8a7f73]">Ảnh nền AI vẽ ở bước 4 — đến lúc đó bấm vào nền để thấy master trên nền.</p>}
        </div>
        {brief.texts.map((t) => (
          <div key={t.id} className="space-y-1.5">
            <div className="text-sm font-medium">
              {t.label} <span className="text-[#c0392b]">*</span>
            </div>
            <div className="rounded-md border bg-white px-3 py-2 text-sm" style={{ fontFamily: t.font || undefined }}>
              {t.kind === "choice" ? `${t.choices[0] ?? ""} ▾` : t.defaultText || "Jessica"}
            </div>
          </div>
        ))}
        {!brief.subjects.some((x) => x.slots.length) && !brief.texts.length && !brief.photoZones.length && <p className="text-xs text-[#8a7f73]">Chưa có option nào cho khách.</p>}
        <div className="rounded-md bg-[#d9814a] py-2 text-center text-sm font-semibold text-white opacity-80">Add to cart</div>
        {brief.mockups.length > 0 && (
          <div className="space-y-1 border-t border-[#e8e2d8] pt-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-[#8a7f73]">Ảnh mockup (AI tạo ở bước 4)</div>
            <ul className="list-disc space-y-0.5 pl-4 text-xs">
              {brief.mockups.filter((m) => m.trim()).map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-[11px] text-[#8a7f73]">Bấm nền để thử; các option khác chỉ để nhìn trực quan.</p>
      </div>
    </div>
  );
}

