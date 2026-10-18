/**
 * The backgrounds of a bộ nhân vật (asked 2026-10-14): brief.backdrops are options the customer picks (snowflakes,
 * Halloween icons, cute emoji…), drawn by the team's image model in step 4 over the whole piece — behind the
 * characters, never part of the master. The product (server/char/product.ts) gets them as one fill layer whose
 * options are these pictures.
 *
 *   POST char/projects/:id/backdrops {ids?: string[], prompts?: {id: prompt}} → { images } (re)draw them now
 *
 * Row: ct_char_images kind "blank" (a step-4 picture, like the phôi), role "backdrop:<backdrop id>"; the newest done
 * row of a backdrop is the one used.
 */

import { NextResponse } from "next/server";
import { CT_TABLES } from "../../config";
import type { CtCharBackdrop, CtCharImage, CtCharProject } from "../../types";
import type { CtSession } from "../supabase";
import { briefTemplate } from "./blank";
import { NOT_YOURS, canEditProject, jobDb, jsonError, loadProject, runCharDraw, type Db } from "./projects";

export const BACKDROP_ROLE = "backdrop:";

/** Each backdrop of the brief with its newest finished picture (in the brief's order; one without a picture is left out). */
export function latestBackdrops(p: CtCharProject, images: CtCharImage[]): Array<{ backdrop: CtCharBackdrop; image: CtCharImage }> {
  return p.brief.backdrops
    .map((backdrop) => ({ backdrop, image: [...images].reverse().find((im) => im.kind === "blank" && im.role === `${BACKDROP_ROLE}${backdrop.id}` && im.status === "done") }))
    .filter((x): x is { backdrop: CtCharBackdrop; image: CtCharImage } => !!x.image);
}

/** The starting prompt of a backdrop: the background alone, flat, filling the piece, calm where the characters go. */
export function backdropPrompt(p: CtCharProject, b: CtCharBackdrop, round: boolean): string {
  return [
    `${(b.value || b.name).replace(/\.$/, "")}.`,
    `A flat printable background artwork for a ${p.brief.product.label || "personalised gift"}, filling the whole picture edge to edge${round ? " (it is printed on a round piece: the corners are cut off)" : ""}.`,
    p.brief.style ? `Drawn to match this art style: ${p.brief.style.replace(/\.$/, "")}.` : "",
    "The characters and the text are printed over it later: keep the middle calm and light — the decorations small (none wider than about 8 % of the picture), scattered evenly, a little denser toward the edges.",
    "No characters, no people, no animals unless described, no text, no letters, no numbers, no frame or border, no product shape, no hanging hole, no mockup — only the flat background design.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** The starting prompt of a repeating background (backdrop.tile): one square of the pattern, flat, edge to edge — the
 * product repeats it (mirrored, so its seams always meet: server/char/product.ts seamlessTile). */
export function tilePrompt(p: CtCharProject, b: CtCharBackdrop): string {
  return [
    `${(b.value || b.name).replace(/\.$/, "")}.`,
    `One square swatch of this repeating pattern for a ${p.brief.product.label || "printed product"}, seen flat from straight above, filling the whole picture edge to edge, evenly lit (no vignette, no shadow, no fold, no perspective), the pattern straight and regular, crisp fabric-print detail.`,
    "Only the pattern: no characters, no objects, no text, no frame or border.",
  ].join(" ");
}

/** (Re)draw backdrops in the background: running rows now, done / failed later. `prompts` replaces the starting
 * prompt of a backdrop; `ids` empty = every backdrop of the brief. */
export async function startBackdrops(db: Db, userId: string, p: CtCharProject, args: { ids?: string[]; prompts?: Record<string, string>; taskId?: string }): Promise<CtCharImage[]> {
  const wanted = new Set([...(args.ids ?? []), ...Object.keys(args.prompts ?? {})]);
  const list = p.brief.backdrops.filter((b) => !wanted.size || wanted.has(b.id));
  const unknown = [...wanted].filter((id) => !p.brief.backdrops.some((b) => b.id === id));
  if (unknown.length) throw new Error(`No backdrop ${unknown.join(", ")} in the brief (brief.backdrops ids)`);
  if (!list.length) throw new Error("The brief has no backdrops — add them to brief.backdrops first");
  const template = await briefTemplate(db, p);
  const round = template ? (template.spec.safe[0]?.type ?? template.spec.outline?.type) === "ellipse" : false;
  // The piece's own ratio (an ornament: square).
  const ratio = template ? template.spec.width / template.spec.height : 1;
  const aspect = ratio > 1.2 ? "3:2" : ratio < 0.83 ? "2:3" : "1:1";
  const rows: CtCharImage[] = [];
  for (const b of list) {
    const prompt = (args.prompts?.[b.id] ?? "").trim() || (b.tile ? tilePrompt(p, b) : backdropPrompt(p, b, round));
    const { data: row } = await db
      .from(CT_TABLES.charImages)
      .insert({ project_id: p.id, user_id: userId, kind: "blank", role: `${BACKDROP_ROLE}${b.id}`, status: "running", note: `Nền — ${b.name}`, prompt, meta: args.taskId ? { taskId: args.taskId } : {} })
      .select("*")
      .single<CtCharImage>();
    if (!row) continue;
    rows.push(row);
    void runCharDraw(db, userId, row, { prompt, refs: [], aspect: b.tile ? "1:1" : aspect, refSize: { w: null, h: null } });
  }
  return rows;
}

/** POST char/projects/:id/backdrops */
export async function backdropsRoute(s: CtSession, id: string, body: unknown): Promise<NextResponse> {
  const p = await loadProject(s.supabase, id);
  if (!p) return jsonError("Không tìm thấy bộ nhân vật", 404);
  if (!(await canEditProject(s, p))) return jsonError(NOT_YOURS, 403);
  const b = (body && typeof body === "object" ? body : {}) as { ids?: unknown };
  const ids = Array.isArray(b.ids) ? b.ids.filter((x): x is string => typeof x === "string") : [];
  try {
    const images = await startBackdrops(jobDb(s), s.user.id, p, { ids });
    return NextResponse.json({ images }, { status: 202 });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không vẽ được nền", 400);
  }
}
