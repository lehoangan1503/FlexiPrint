/**
 * The phôi trơn of a bộ nhân vật (asked 2026-10-10): when the brief has a khuôn in but no blank photo was uploaded,
 * the team's image model draws one from the khuôn (its outline, hole, size) when asked in step 4 (never on its own,
 * since 2026-10-13) — the products get it for Xem trước and Mockups (server/product-mockups.ts).
 *
 *   POST char/projects/:id/blank  → { image } (re)make it now
 *
 * Row: ct_char_images kind "blank", role "blank:ai" (an uploaded one is role "blank").
 */

import { NextResponse } from "next/server";
import { CT_TABLES } from "../../config";
import type { CtCharBrief, CtCharImage, CtCharProject } from "../../types";
import { layoutHint } from "../../lib/print-template";
import type { CtPrintTemplate } from "../../types/print";
import { makeBlank } from "../product-mockups";
import { templateRow } from "../print-templates";
import { addTemplateBlank } from "../print-blanks";
import type { CtSession } from "../supabase";
import { saveCharFile } from "./files";
import { jobDb, jsonError, loadProject, type Db, canEditProject, NOT_YOURS } from "./projects";

export const AI_BLANK_ROLE = "blank:ai";

/** The khuôn in of the brief, if any. */
export async function briefTemplate(db: Db, p: CtCharProject): Promise<CtPrintTemplate | null> {
  const id = p.brief.product.templateId;
  if (!id) return null;
  const { data } = await db.from(CT_TABLES.printTemplates).select("*").eq("id", id).maybeSingle<CtPrintTemplate>();
  return data ? templateRow(data) : null;
}

/** A brief whose product names a khuôn in gets what the page fills in when one is picked (TemplatePick): the cut,
 * the size, the label and the layout sentence the master prompt carries — so @flexiprint only sets templateId. */
export async function withTemplateProduct(db: Db, brief: CtCharBrief): Promise<CtCharBrief> {
  const id = brief.product.templateId;
  if (!id) return brief;
  const { data } = await db.from(CT_TABLES.printTemplates).select("*").eq("id", id).maybeSingle<CtPrintTemplate>();
  if (!data) throw new Error(`No khuôn in ${id} — list_print_templates`);
  const t = templateRow(data);
  const p = brief.product;
  return {
    ...brief,
    product: {
      ...p,
      label: p.label || t.name,
      cut: t.kind === "cut" ? "alpha" : t.spec.outline || t.spec.faces.some((f) => f.maskUrl) ? "frame" : "rect",
      widthMm: t.spec.widthMm || p.widthMm,
      heightMm: t.spec.heightMm || p.heightMm,
      layout: p.layout || layoutHint(t.kind, t.spec),
    },
  };
}

/** The phôi a product of the set gets: the uploaded one, else the newest AI one that is done. */
export function projectBlank(p: CtCharProject, images: CtCharImage[]): CtCharImage | null {
  const uploaded = p.brief.product.blankId ? images.find((im) => im.id === p.brief.product.blankId && im.status === "done") : undefined;
  if (uploaded) return uploaded;
  return [...images].reverse().find((im) => im.kind === "blank" && im.role === AI_BLANK_ROLE && im.status === "done") ?? null;
}

/** Start drawing an AI phôi (a running row now, done / failed later). Never throws. */
export async function startCharBlank(db: Db, userId: string, p: CtCharProject): Promise<CtCharImage | null> {
  const template = await briefTemplate(db, p);
  const label = p.brief.product.label || template?.name || "product";
  const { data: row } = await db
    .from(CT_TABLES.charImages)
    .insert({ project_id: p.id, user_id: userId, kind: "blank", role: AI_BLANK_ROLE, status: "running", note: `Phôi trơn AI — ${label}`, prompt: "" })
    .select("*")
    .single<CtCharImage>();
  if (!row) return null;
  void (async () => {
    try {
      const photo = await makeBlank(userId, label, template?.spec ?? null, p.brief.product.material);
      const saved = await saveCharFile(userId, p.id, "blank", photo);
      await db.from(CT_TABLES.charImages).update({ ...saved, status: "done", error: "" }).eq("id", row.id);
      // Kept with the khuôn too: the next brief / product on the same piece reuses it.
      if (template) await addTemplateBlank(db, userId, template, photo, "Phôi AI", true).catch(() => undefined);
    } catch (e) {
      await db.from(CT_TABLES.charImages).update({ status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 1000) }).eq("id", row.id);
    }
  })();
  return row;
}

/** POST char/projects/:id/blank */
export async function makeCharBlank(s: CtSession, id: string): Promise<NextResponse> {
  const p = await loadProject(s.supabase, id);
  if (!p) return jsonError("Không tìm thấy bộ nhân vật", 404);
  if (!(await canEditProject(s, p))) return jsonError(NOT_YOURS, 403);
  const image = await startCharBlank(jobDb(s), s.user.id, p);
  return image ? NextResponse.json({ image }, { status: 202 }) : jsonError("Không tạo được", 500);
}
