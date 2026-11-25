/**
 * MCP đợt 4 (2026-11-25, luật "mỗi nút giao diện có API + MCP"): the bộ nhân vật page's hand edits and the editor's
 * "Lưu thành bộ clipart" — read a bộ's files / cut state, sửa tay một file clipart (mask, kéo, cân màu) + hoàn tác,
 * duyệt bộ file, the cut steps (3a matte: chấm điểm xoá nền / hoàn tác / duyệt; 3c plan: vẽ lại vùng / hoàn tác / duyệt),
 * the order and the test photos of a bộ ảnh khách's styles.
 * Every change goes through the page's own route (server/char/router.ts dispatchChar): the same checks (maker or
 * admin, "đang cắt"), and @flexiprint working on the bộ is told of the change like a change made on the page.
 */

import { NextRequest } from "next/server";
import sharp from "sharp";
import { CT_TABLES } from "../../config";
import { CT_MAIN_KEY, type CtCharImage, type CtCharProject, type CtExtractSetBody, type CtSelection } from "../../types";
import { normalizeProductConfig, zoneSubtree } from "../../lib/design";
import { resolveLayout } from "../../lib/layout";
import { str } from "../ai/llm";
import { dispatchChar } from "../char/router";
import { extractCharSet } from "../char/extract-set";
import { fetchImage } from "../char/files";
import { loadArtwork, renderArtwork } from "../print-render";
import { ownedProduct } from "../handlers";
import type { CtSession } from "../supabase";
import { answer, idOf, session } from "./crud-tools";
import { OPT_TASK_ARG, json } from "./task-common";
import type { CtMcpTool } from "./tools";

const MAX_FILE = 40 * 1024 * 1024;

/** One call of the bộ nhân vật page's route, as the page makes it (path = char/projects/:id/…). */
export async function charCall(s: CtSession, method: "GET" | "POST" | "PATCH", path: string[], body?: unknown): Promise<Record<string, unknown>> {
  const init = method === "GET" ? { method } : { method, body: JSON.stringify(body ?? {}), headers: { "content-type": "application/json" } };
  const req = new NextRequest(`http://localhost/api/ct/${path.join("/")}`, init);
  return answer(await dispatchChar(req, s, path));
}

/** A PNG from `<key>_url` (https) or `<key>_base64` (a data: url or bare base64) as the page sends it (a data: url). */
async function pngArg(args: Record<string, unknown>, key: string): Promise<string | undefined> {
  const b64 = str(args[`${key}_base64`]).replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  const url = str(args[`${key}_url`]).trim();
  if (!b64 && !url) return undefined;
  let data: Buffer;
  if (b64) data = Buffer.from(b64, "base64");
  else if (/^https:\/\/\S+$/.test(url)) data = await fetchImage(url);
  else throw new Error(`${key}_url must be an https link`);
  if (!data.length) throw new Error(`${key}: the file is empty`);
  if (data.length > MAX_FILE) throw new Error(`${key}: the file is over 40 MB`);
  const png = await sharp(data, { limitInputPixels: 20000 * 20000 }).ensureAlpha().png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

function projectOut(p: CtCharProject): Record<string, unknown> {
  const layers = p.layers;
  const cut = p.cut;
  return {
    id: p.id,
    name: p.name,
    status: p.status,
    product_ids: p.product_ids,
    layers: layers
      ? {
          status: layers.status,
          error: layers.error || undefined,
          approved: layers.approved === true,
          width: layers.width,
          height: layers.height,
          red_checks: layers.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`),
          slots: layers.slots.map((sl) => ({
            key: sl.key,
            label: sl.label,
            follows: sl.follows,
            files: sl.files.map((f) => ({ image_id: f.imageId, option: f.option, color: f.color, url: f.url, edited: !!f.editMaskUrl || !!f.editFix, offset: f.offset, undo_steps: f.history?.length ?? 0 })),
          })),
        }
      : null,
    matte: cut?.matte
      ? { status: cut.matte.status, error: cut.matte.error || undefined, width: cut.matte.width, height: cut.matte.height, colour_url: cut.matte.colourUrl, preview_url: cut.matte.previewUrl, alpha_url: cut.matte.alpha?.url ?? null, edited: cut.matte.alpha?.edited ?? false, undo_steps: cut.matte.alpha?.history.length ?? 0, approved: cut.matte.approved }
      : null,
    plan: cut?.plan
      ? {
          status: cut.plan.status,
          error: cut.plan.error || undefined,
          width: cut.plan.width,
          height: cut.plan.height,
          approved: cut.plan.approved,
          red_checks: cut.plan.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`),
          pictures: cut.plan.pictures.map((x) => ({ id: x.id, label: x.label, colour_url: x.colourUrl, preview_url: x.previewUrl })),
          pieces: cut.plan.pieces.map((x) => ({ key: x.key, label: x.label, slot: x.slot, option: x.option, picture: x.picture, region_url: x.region.url, edited: x.region.edited, undo_steps: x.region.history.length })),
        }
      : null,
  };
}

const SET_ID = { project_id: { type: "string", description: "The bộ (char_list_sets)." } };
const MASK_IN = (what: string) => ({
  mask_url: { type: "string", description: `${what} — an https link to the PNG.` },
  mask_base64: { type: "string", description: "Or the PNG itself, base64 (a data: url works too)." },
});

export const CT_MCP_CHAR_EDIT_TOOLS: CtMcpTool[] = [
  {
    name: "char_get_set",
    description:
      "Read a bộ nhân vật as its page shows it: the files of the bộ (3c, per layer: image_id, option, colour, url, edited, undo steps), the master at print size (3a matte: colour / alpha urls, approved) and the regions of the cut (3c plan: pieces with key, region_url, edited). The ids and urls the hand-edit tools take.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, ...SET_ID }, required: ["project_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const out = await charCall(s, "GET", ["char", "projects", idOf(args, "project_id")]);
      const p = out.project as CtCharProject;
      const images = (out.images as CtCharImage[] | undefined) ?? [];
      return json({ ...projectOut(p), images: images.length });
    },
  },
  {
    name: "char_edit_file",
    description:
      "Sửa tay một file clipart of a bộ (the page's file editor: cọ / tẩy, kéo, cân màu). Every colour of that option changes the same way, and every product clipart copied from it. Give at least one of: mask (the file's new alpha: a PNG the size of the bộ's canvas — layers.width × layers.height — white, alpha = what stays), move {dx, dy} (whole px; every file of the option moves), fix (cân màu: the brush's PNG, same size, alpha = where it went). Undo with char_revert_file. Refused while the bộ is being cut.",
    inputSchema: {
      type: "object",
      properties: {
        ...OPT_TASK_ARG,
        ...SET_ID,
        image_id: { type: "string", description: "The file (char_get_set → layers.slots[].files[].image_id; a front file for hair)." },
        ...MASK_IN("The file's new alpha on the bộ's canvas"),
        move: { type: "object", description: "{dx, dy} px — move the clipart (all its colours, back and front)." },
        fix_url: { type: "string", description: "Cân màu: the brush (PNG, the canvas size, alpha = where) — https link." },
        fix_base64: { type: "string", description: "Or that PNG as base64." },
        grow_url: { type: "string", description: "Cân màu \"Thêm\": where the file may grow over an uncovered strip (PNG) — https link." },
        grow_base64: { type: "string", description: "Or that PNG as base64." },
        band: { type: "number", description: "Cân màu: edge band width in px (1–10, default 6)." },
        tol: { type: "number", description: "Cân màu: colour tolerance (default 10)." },
        grow: { type: "number", description: "Cân màu: how far the file may grow, px (default 2)." },
      },
      required: ["project_id", "image_id"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = idOf(args, "project_id");
      const mask = await pngArg(args, "mask");
      const fixPng = await pngArg(args, "fix");
      const growPng = await pngArg(args, "grow");
      const mv = args.move && typeof args.move === "object" ? (args.move as { dx?: unknown; dy?: unknown }) : null;
      const body: Record<string, unknown> = { imageId: idOf(args, "image_id") };
      if (mask) body.mask = mask;
      if (mv) body.move = { dx: Number(mv.dx) || 0, dy: Number(mv.dy) || 0 };
      if (fixPng || growPng) body.fix = { ...(fixPng ? { png: fixPng } : {}), ...(growPng ? { growPng } : {}), ...(typeof args.band === "number" ? { band: args.band } : {}), ...(typeof args.tol === "number" ? { tol: args.tol } : {}), ...(typeof args.grow === "number" ? { grow: args.grow } : {}) };
      const out = await charCall(s, "POST", ["char", "projects", id, "layers", "file"], body);
      return json(projectOut(out.project as CtCharProject));
    },
  },
  {
    name: "char_revert_file",
    description: "Hoàn tác: a clipart file of a bộ back to how it was before its last hand edit (every colour of the option). Up to 8 steps back.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, ...SET_ID, image_id: { type: "string", description: "The file (char_get_set)." } }, required: ["project_id", "image_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const out = await charCall(s, "POST", ["char", "projects", idOf(args, "project_id"), "layers", "file", "revert"], { imageId: idOf(args, "image_id") });
      return json(projectOut(out.project as CtCharProject));
    },
  },
  {
    name: "char_approve_layers",
    description: "Duyệt bộ file (3c) of a bộ — or take the approval back (approved false). Only once the cut is done.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, ...SET_ID, approved: { type: "boolean", description: "Default true; false = bỏ duyệt." } }, required: ["project_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const out = await charCall(s, "POST", ["char", "projects", idOf(args, "project_id"), "layers", "approve"], { approved: args.approved !== false });
      return json(projectOut(out.project as CtCharProject));
    },
  },
  {
    name: "char_cut_step",
    description:
      "The cut steps of a bộ by hand, as on its page. step \"matte\" (3a, the master at print size without its backdrop): action start = make it again, fix = remove leftover backdrop around points [{x, y}] (px of the matte, ≤ 300), revert = undo the last fix, approve. step \"plan\" (3c, each layer's region): start = find every region again (auto true = then cut on its own), region = a region drawn again (key + mask: PNG the plan's size, white, alpha = the region), revert = undo the last region change (key), approve. approve takes approved false to take it back. A fix / region un-approves the step. start runs in the background — read char_get_set.",
    inputSchema: {
      type: "object",
      properties: {
        ...OPT_TASK_ARG,
        ...SET_ID,
        step: { type: "string", description: "matte | plan" },
        action: { type: "string", description: "start | fix (matte) | region (plan) | revert | approve" },
        points: { type: "array", items: { type: "object" }, description: "matte fix: [{x, y}] px on the matte." },
        key: { type: "string", description: "plan region / revert: the piece (char_get_set → plan.pieces[].key)." },
        ...MASK_IN("plan region: the region"),
        approved: { type: "boolean", description: "approve: default true." },
        auto: { type: "boolean", description: "plan start: true = cut the files once the regions are found." },
      },
      required: ["project_id", "step", "action"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = idOf(args, "project_id");
      const step = str(args.step);
      const action = str(args.action);
      if (step !== "matte" && step !== "plan") throw new Error('step: "matte" or "plan"');
      const allowed = step === "matte" ? ["start", "fix", "revert", "approve"] : ["start", "region", "revert", "approve"];
      if (!allowed.includes(action)) throw new Error(`action for ${step}: ${allowed.join(" | ")}`);
      const path = ["char", "projects", id, step, ...(action === "start" ? [] : [action])];
      let body: Record<string, unknown> = {};
      if (action === "approve") body = { approved: args.approved !== false };
      else if (action === "fix") body = { points: Array.isArray(args.points) ? args.points : [] };
      else if (action === "region") body = { key: str(args.key), mask: await pngArg(args, "mask") };
      else if (action === "revert" && step === "plan") body = { key: str(args.key) };
      else if (action === "start" && step === "plan") body = { auto: args.auto === true };
      const out = await charCall(s, "POST", path, body);
      return json(projectOut(out.project as CtCharProject));
    },
  },
  {
    name: "char_order_photo_styles",
    description: "Bộ ảnh khách: the order its AI styles are offered in (the page's drag order) — style_ids first to last. zone_id = for one photo zone of its product only.",
    inputSchema: {
      type: "object",
      properties: { ...OPT_TASK_ARG, ...SET_ID, style_ids: { type: "array", items: { type: "string" }, description: "Every style id, in order (char_test_photo_styles / the bộ's styles)." }, zone_id: { type: "string", description: "Optional: one photo zone." } },
      required: ["project_id", "style_ids"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const ids = Array.isArray(args.style_ids) ? args.style_ids.map(String) : [];
      if (!ids.length) throw new Error("style_ids is empty");
      await charCall(s, "POST", ["char", "projects", idOf(args, "project_id"), "photo-styles", "order"], { styleIds: ids, ...(str(args.zone_id) ? { zoneId: str(args.zone_id) } : {}) });
      return json({ ok: true, order: ids });
    },
  },
  {
    name: "char_set_test_photos",
    description: "Bộ ảnh khách: the customer photos its styles are tried on (the page's \"Ảnh thử\") — https urls, the whole list (char_test_photo_styles then draws on them). zone_id = for one photo zone only.",
    inputSchema: {
      type: "object",
      properties: { ...OPT_TASK_ARG, ...SET_ID, photos: { type: "array", items: { type: "string" }, description: "https urls of the test photos (upload_image for a file)." }, zone_id: { type: "string", description: "Optional: one photo zone." } },
      required: ["project_id", "photos"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const photos = Array.isArray(args.photos) ? args.photos.map((x) => String(x).trim()).filter(Boolean) : [];
      if (photos.some((u) => !/^https:\/\/\S+$/.test(u))) throw new Error("photos: https urls only");
      await charCall(s, "POST", ["char", "projects", idOf(args, "project_id"), "photo-styles", "photos"], { photos, ...(str(args.zone_id) ? { zoneId: str(args.zone_id) } : {}) });
      return json({ ok: true, photos });
    },
  },
  {
    name: "char_extract_set",
    description:
      "Lưu thành bộ clipart (the editor's layer menu): the picked layers of one version of a product saved as a bộ clipart of their own — copies at the same place on a blank canvas of the version's size, every option they have and the zones hanging under them (the boy with every hair / outfit, to sit him somewhere else). Its picture in the library = those layers drawn alone, cropped. Layers showing a version's own canvas and material frames stay behind. → the new bộ and its product.",
    inputSchema: {
      type: "object",
      properties: {
        ...OPT_TASK_ARG,
        product_id: { type: "string", description: "The product / artwork the layers are in." },
        region_ids: { type: "array", items: { type: "string" }, description: "The layers picked (get_product_design → regions[].id); their child zones come along." },
        name: { type: "string", description: "The bộ's name." },
        version_id: { type: "string", description: "The version (main asset id) they are taken from; default the product's main." },
        from_set_id: { type: "string", description: "Picked on a bộ in the library (its product = product_id): the new bộ is its child." },
      },
      required: ["product_id", "region_ids", "name"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const productId = idOf(args, "product_id");
      const fromSetId = str(args.from_set_id);
      // Your own product, or the product of the bộ picked in the library (as the set picker does).
      let product = await ownedProduct(s, productId);
      if (!product && fromSetId) {
        const { data } = await s.supabase.from(CT_TABLES.charProjects).select("product_ids").eq("id", fromSetId).maybeSingle<{ product_ids: string[] }>();
        if (data?.product_ids.includes(productId)) product = (await loadArtwork(s.supabase, productId))?.product ?? null;
      }
      if (!product) throw new Error("No such product / artwork, or you may not edit it");
      const bundle = await loadArtwork(s.supabase, productId);
      if (!bundle) throw new Error("No such product");
      const mainId = str(args.version_id) || product.main_asset_id || "";
      const main = bundle.assets.find((a) => a.id === mainId && a.role === "main");
      if (!main) throw new Error("version_id is not a version of this product (get_product_design → versions)");
      const config = normalizeProductConfig(product.config);
      const shown = resolveLayout(bundle.regions, bundle.items, config.layouts, mainId);
      const ids = Array.isArray(args.region_ids) ? args.region_ids.map(String) : [];
      if (!ids.length) throw new Error("region_ids is empty");
      const missing = ids.filter((id) => !shown.regions.some((r) => r.id === id));
      if (missing.length) throw new Error(`Not layers of that version: ${missing.join(", ")}`);
      const want = new Set(ids.flatMap((id) => [...zoneSubtree(shown.regions, id)]));
      const picked = shown.regions.filter((r) => want.has(r.id));
      const pickedItems = shown.items.filter((i) => want.has(i.region_id));
      // The picture: only these layers, the version's own picture left out, cropped close to its pixels.
      let preview = "";
      try {
        const selection: CtSelection = { [CT_MAIN_KEY]: { kind: "main", assetId: mainId } } as CtSelection;
        const shot = await renderArtwork({ ...bundle, product: { ...bundle.product, main_asset_id: mainId }, regions: bundle.regions.filter((r) => want.has(r.id)), items: bundle.items.filter((i) => want.has(i.region_id)) }, selection, 1200, "print");
        const trimmed = await sharp(shot).trim().png().toBuffer().catch(() => shot);
        preview = `data:image/png;base64,${trimmed.toString("base64")}`;
      } catch (e) {
        console.warn("[ct] mcp extract preview", e instanceof Error ? e.message : String(e));
      }
      const body: CtExtractSetBody = { name: str(args.name), productId, width: main.width, height: main.height, regions: picked, items: pickedItems, preview, ...(fromSetId ? { fromSetId } : {}) };
      const out = await answer(await extractCharSet(s, body));
      const p = out.project as CtCharProject;
      return json({ project_id: p.id, name: p.name, product_id: out.productId, layers: out.layers, skipped: out.skipped, has_picture: !!preview });
    },
  },
];
