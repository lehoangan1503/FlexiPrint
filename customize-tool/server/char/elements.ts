/**
 * The pieces of a bộ ảnh khách (brief.kind "photo", asked 2026-10-15): the customer's photo is the hero, the set is
 * the decorations around it — and the decorations of a bộ nhân vật (asked 2026-10-18: a ribbon banner, the year in
 * glitter numbers, a Christmas tree beside the family). Each option of each element is drawn ALONE on transparency in the approved master's
 * look (no doll, no pixel lock — the customer's photo has its own outline, so a wing behind it must be whole):
 *
 *   POST char/projects/:id/elements {roles?: string[], prompts?: {role: prompt}} → { images } (re)draw now
 *
 * Rows: ct_char_images kind "edit", role "el:<element id>:<option id>" (an option) or "el:<element id>:bd:<backdrop
 * id>" (a perBackdrop element: one picture per background, drawn with that background as reference). A colour
 * element draws its first option only; the others are recoloured from it when it is done (model "recolor", same
 * outline). The newest done row of a role is the one used.
 */

import { NextResponse } from "next/server";
import sharp from "sharp";
import { CT_TABLES } from "../../config";
import type { CtCharBackdrop, CtCharElement, CtCharImage, CtCharProject } from "../../types";
import { elementAspect, elementPrompt, plaqueAspect, plaqueShape } from "../../lib/char-brief";
import type { CtSession } from "../supabase";
import { latestBackdrops } from "./backdrops";
import { briefTemplate } from "./blank";
import { safeShapes } from "../../lib/print-template";
import { shapeBounds } from "../../lib/geometry";
import { fetchImage, saveCharFile } from "./files";
import { NOT_YOURS, canEditProject, jobDb, jsonError, loadImages, loadProject, runCharDraw, type Db } from "./projects";

export const ELEMENT_ROLE = "el:";
/** The zone's sample (the master's pet alone, in the style): role "sample:<zone id>". */
export const SAMPLE_ROLE = "sample:";

/** One picture an element needs: an option, or (perBackdrop) a background's matching one. */
export interface ElementPicture {
  role: string;
  element: CtCharElement;
  /** The option's name the customer sees ("Feathered White"), or the background's name. */
  name: string;
  /** The look in words for the image model. */
  look: string;
  backdrop?: CtCharBackdrop;
  /** A colour option recoloured from the element's first picture (not drawn). */
  recolor?: string;
}

/** Every picture the brief's elements need, in the brief's order. */
export function elementPictures(p: CtCharProject): ElementPicture[] {
  const out: ElementPicture[] = [];
  for (const e of p.brief.elements) {
    if (e.perBackdrop) {
      const look = e.options[0]?.value || e.name;
      for (const b of p.brief.backdrops) out.push({ role: `${ELEMENT_ROLE}${e.id}:bd:${b.id}`, element: e, name: b.name, look, backdrop: b });
      continue;
    }
    e.options.forEach((o, i) => {
      const hex = /^#[0-9a-f]{6}$/i.test(o.value) ? o.value : "";
      const look = e.mode === "color" ? `${e.name} in ${o.name}${hex ? ` (${hex})` : ""}` : o.value || o.name;
      out.push({ role: `${ELEMENT_ROLE}${e.id}:${o.id}`, element: e, name: o.name, look, ...(e.mode === "color" && i > 0 ? { recolor: hex || "#cccccc" } : {}) });
    });
  }
  return out;
}

/** The newest finished picture of each element role. */
export function latestElementImages(images: CtCharImage[]): Map<string, CtCharImage> {
  const out = new Map<string, CtCharImage>();
  for (const im of images) if ((im.role.startsWith(ELEMENT_ROLE) || im.role.startsWith(SAMPLE_ROLE)) && im.status === "done" && (!out.has(im.role) || out.get(im.role)!.created_at < im.created_at)) out.set(im.role, im);
  return out;
}

/** The picture an element is drawn in the look of: the approved master. */
async function masterUrl(db: Db, p: CtCharProject): Promise<string> {
  // Characters drawn in their poses: the first pose with an approved master gives the look.
  if (!p.master_id && p.brief.poses?.length) {
    const { data: kids } = await db.from(CT_TABLES.charProjects).select("master_id, brief").eq("brief->versionOf->>id", p.id).returns<Array<Pick<CtCharProject, "master_id" | "brief">>>();
    const order = (k: Pick<CtCharProject, "brief">) => p.brief.poses!.findIndex((x) => x.id === k.brief.versionOf?.pose);
    const first = (kids ?? []).filter((k) => k.master_id && order(k) >= 0).sort((a, b) => order(a) - order(b))[0];
    if (!first?.master_id) throw new Error("Duyệt master của ít nhất một dáng trước — các phần tử được vẽ theo nó");
    const { data } = await db.from(CT_TABLES.charImages).select("url").eq("id", first.master_id).single<{ url: string }>();
    if (!data?.url) throw new Error("Không thấy master của dáng");
    return data.url;
  }
  if (!p.master_id) throw new Error("Duyệt master trước — các phần tử được vẽ theo nó");
  const { data } = await db.from(CT_TABLES.charImages).select("url").eq("id", p.master_id).single<{ url: string }>();
  if (!data?.url) throw new Error("Không thấy master");
  return data.url;
}

/**
 * A colour option from the first one: every pixel takes the target colour at its own lightness (darker than the
 * picture's middle tone → the target darkened, lighter → toward white), alpha kept — same outline, same shading.
 */
export async function recolorPicture(png: Buffer, hex: string): Promise<Buffer> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const t = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
  const ys: number[] = [];
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 128) ys.push(lum(data[i], data[i + 1], data[i + 2]));
  ys.sort((a, b) => a - b);
  const mid = Math.max(1, ys[ys.length >> 1] ?? 128);
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue;
    const y = lum(data[i], data[i + 1], data[i + 2]);
    for (let c = 0; c < 3; c++) data[i + c] = Math.round(y <= mid ? (t[c] * y) / mid : t[c] + ((255 - t[c]) * (y - mid)) / Math.max(1, 255 - mid));
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

/** The recolours of a colour element once its first picture is done. */
async function recolorFrom(db: Db, userId: string, p: CtCharProject, first: CtCharImage, rest: ElementPicture[], taskId?: string): Promise<void> {
  const src = await fetchImage(first.url);
  for (const pic of rest) {
    const { data: row } = await db
      .from(CT_TABLES.charImages)
      .insert({ project_id: p.id, user_id: userId, kind: "edit", role: pic.role, status: "running", note: `${pic.element.name} — ${pic.name} (đổi màu)`, prompt: `recolour ${pic.recolor}`, meta: { sourceId: first.id, ...(taskId ? { taskId } : {}) } })
      .select("*")
      .single<CtCharImage>();
    if (!row) continue;
    try {
      const saved = await saveCharFile(userId, p.id, "edit", await recolorPicture(src, pic.recolor!));
      await db.from(CT_TABLES.charImages).update({ ...saved, model: "recolor", status: "done", error: "" }).eq("id", row.id);
    } catch (e) {
      await db.from(CT_TABLES.charImages).update({ status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 1000) }).eq("id", row.id);
    }
  }
}

/** (Re)draw element pictures in the background: running rows now. `roles` / `prompts` keys empty = every picture the
 * brief needs that has no finished one yet; a colour option is recoloured from its element's first picture. */
export async function startElements(db: Db, userId: string, p: CtCharProject, args: { roles?: string[]; prompts?: Record<string, string>; taskId?: string }): Promise<CtCharImage[]> {
  const all = elementPictures(p);
  if (!all.length) throw new Error("Brief chưa có phần tử nào (brief.elements)");
  const images = await loadImages(db, p.id);
  const done = latestElementImages(images);
  const wanted = new Set([...(args.roles ?? []), ...Object.keys(args.prompts ?? {})]);
  // A bộ ảnh khách's zone sample (the master's pet alone); a bộ nhân vật's photo zones are holes in its characters.
  const samples = p.brief.kind === "photo" ? p.brief.photoZones.map((z) => ({ role: `${SAMPLE_ROLE}${z.id}`, zone: z })) : [];
  const unknown = [...wanted].filter((r) => !all.some((x) => x.role === r) && !samples.some((x) => x.role === r));
  if (unknown.length) throw new Error(`Không có ${unknown.join(", ")} — role là "el:<element id>:<option id>" hoặc "el:<element id>:bd:<backdrop id>"`);
  // A colour option asked again redraws its element's first picture (it is a recolour of it).
  const firstOf = (e: CtCharElement) => all.find((x) => x.element.id === e.id && !x.recolor)!;
  const pick = wanted.size ? all.filter((x) => wanted.has(x.role)).map((x) => (x.recolor ? firstOf(x.element) : x)) : all.filter((x) => !x.recolor && !done.has(x.role));
  const draws = [...new Map(pick.map((x) => [x.role, x])).values()];
  const master = await masterUrl(db, p);
  const backdrops = latestBackdrops(p, images);
  // A placed element is drawn in its box's shape on the piece (the safe area's ratio).
  const template = await briefTemplate(db, p);
  const safe = template ? safeShapes(template.spec)[0] : undefined;
  const sb = safe ? shapeBounds(safe) : null;
  const areaRatio = sb ? sb.w / sb.h : template ? template.spec.width / template.spec.height : 1;
  const rows: CtCharImage[] = [];
  for (const pic of draws) {
    const bd = pic.backdrop ? backdrops.find((x) => x.backdrop.id === pic.backdrop!.id)?.image : undefined;
    if (pic.backdrop && !bd) throw new Error(`Vẽ nền "${pic.backdrop.name}" trước (bước 4) — "${pic.element.name}" được vẽ theo màu của nó`);
    const own = (args.prompts?.[pic.role] ?? "").trim();
    // A sign is always drawn at the set's one sign ratio, whoever wrote the prompt.
    const prompt = own ? (pic.element.place === "plaque" && !own.includes("times as wide") ? `${own} ${plaqueShape(plaqueAspect(areaRatio))}` : own) : elementPrompt(p.brief, pic.element, pic.look, pic.backdrop, areaRatio);
    const { data: row } = await db
      .from(CT_TABLES.charImages)
      .insert({ project_id: p.id, user_id: userId, kind: "edit", role: pic.role, status: "running", note: `${pic.element.name} — ${pic.name}`, prompt, meta: args.taskId ? { taskId: args.taskId } : {} })
      .select("*")
      .single<CtCharImage>();
    if (!row) continue;
    rows.push(row);
    const recolors = all.filter((x) => x.element.id === pic.element.id && x.recolor);
    void (async () => {
      const out = await runCharDraw(db, userId, row, { prompt, refs: [master, ...(bd ? [bd.url] : [])], aspect: elementAspect(pic.element, areaRatio), refSize: { w: null, h: null }, transparent: true });
      if (out && recolors.length) await recolorFrom(db, userId, p, out, recolors, args.taskId);
    })();
  }
  // The zones' samples: what a customer's photo looks like in the style (shown until they upload).
  for (const { role, zone } of samples) {
    if (wanted.size ? !wanted.has(role) : done.has(role)) continue;
    const prompt =
      (args.prompts?.[role] ?? "").trim() ||
      `Reference picture 1 is the finished design. Draw ONLY ${zone.where} exactly as it is drawn there — the same look, pose, colours and style — alone and whole (nothing cut off, the whole body), centred, as large as fits. Nothing else: no wings, no halo, no clouds, no background, no text. A fully transparent background around it.`;
    const { data: row } = await db
      .from(CT_TABLES.charImages)
      .insert({ project_id: p.id, user_id: userId, kind: "edit", role, status: "running", note: `Ảnh mẫu — ${zone.label}`, prompt, meta: args.taskId ? { taskId: args.taskId } : {} })
      .select("*")
      .single<CtCharImage>();
    if (!row) continue;
    rows.push(row);
    void runCharDraw(db, userId, row, { prompt, refs: [master], aspect: "1:1", refSize: { w: null, h: null }, transparent: true });
  }
  if (!rows.length && !wanted.size) throw new Error("Mọi phần tử đã có ảnh — chọn role để vẽ lại");
  return rows;
}

/** POST char/projects/:id/elements */
export async function elementsRoute(s: CtSession, id: string, body: unknown): Promise<NextResponse> {
  const p = await loadProject(s.supabase, id);
  if (!p) return jsonError("Không tìm thấy bộ", 404);
  if (!(await canEditProject(s, p))) return jsonError(NOT_YOURS, 403);
  const b = (body && typeof body === "object" ? body : {}) as { roles?: unknown; prompts?: unknown };
  const roles = Array.isArray(b.roles) ? b.roles.filter((x): x is string => typeof x === "string") : [];
  const prompts =
    b.prompts && typeof b.prompts === "object" && !Array.isArray(b.prompts)
      ? Object.fromEntries(Object.entries(b.prompts as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"))
      : {};
  try {
    const images = await startElements(jobDb(s), s.user.id, p, { roles, prompts });
    return NextResponse.json({ images }, { status: 202 });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không vẽ được", 400);
  }
}
