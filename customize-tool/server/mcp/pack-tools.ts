/**
 * MCP đợt 4 (2026-11-25, luật "mỗi nút giao diện có API + MCP"): the mockup library pages and the editor's sample
 * customers — bộ mockup (ct_mockup_packs: list / tạo / sửa / xoá, ảnh nền), thư viện ảnh mockup (ct_pack_images:
 * tìm / xem / tải lên / xoá), ảnh mẫu người / thú theo vùng ảnh (POST products/:id/mockups/samples) and the material
 * presets list. Every tool runs as the signed-in user through the same handler as the page. The service session skips
 * RLS, so where a handler leans on RLS for "owner or admin" the check is made here first.
 */

import { CT_TABLES } from "../../config";
import type { CtMockupPackBody } from "../../types";
import { str } from "../ai/llm";
import * as packs from "../mockup-packs";
import * as packImages from "../pack-images";
import { mockupSamples } from "../mockup-samples";
import { listPresets } from "../library";
import type { CtSession } from "../supabase";
import { answer, idOf, session } from "./crud-tools";
import { adminOf, fileOf } from "./library-tools";
import { OPT_TASK_ARG, json } from "./task-common";
import type { CtMcpContext, CtMcpTool } from "./tools";

/** A row of a library table the caller may change: its maker or an admin (the page's RLS rule). */
async function mayChange(ctx: CtMcpContext, s: CtSession, table: string, id: string, what: string): Promise<void> {
  const { data } = await s.supabase.from(table).select("user_id").eq("id", id).maybeSingle<{ user_id: string | null }>();
  if (!data) throw new Error(`No such ${what}`);
  if (data.user_id !== s.user.id && !(await adminOf(ctx, s))) throw new Error(`Only the ${what}'s maker or an admin may change it`);
}

function packBody(args: Record<string, unknown>, was?: CtMockupPackBody): CtMockupPackBody {
  return {
    name: typeof args.name === "string" ? args.name : was?.name ?? "",
    notes: typeof args.notes === "string" ? args.notes : was?.notes ?? "",
    slides: Array.isArray(args.slides) ? (args.slides as CtMockupPackBody["slides"]) : was?.slides ?? [],
    thumbnail_url: typeof args.thumbnail_url === "string" ? args.thumbnail_url || null : was?.thumbnail_url ?? null,
  };
}

const IMAGE_IN = {
  image_url: { type: "string", description: "An https link to the picture." },
  data_base64: { type: "string", description: "Or the file itself, base64 (a data: url works too) — for a file on the caller's machine." },
};

const PACK_ID = { pack_id: { type: "string", description: "From list_mockup_packs." } };

export const CT_MCP_PACK_TOOLS: CtMcpTool[] = [
  // ---------------------------------------------------------------- bộ mockup (hand-made scenes)
  {
    name: "list_mockup_packs",
    description: "Bộ mockup (library → Mockup): every pack of hand-made scenes — name, notes, slides (each scene: size + layers bottom first: picture frames the product goes in, backgrounds, overlays), can_edit. full false = names and scene counts only.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, full: { type: "boolean", description: "Default false: no slide bodies." } } },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const out = await answer(await packs.listPacks(await session(ctx, args)));
      const list = (out.packs as Array<Record<string, unknown> & { slides: unknown[] }>) ?? [];
      return json({ admin: out.admin, packs: args.full === true ? list : list.map((p) => ({ id: p.id, name: p.name, notes: p.notes, scenes: p.slides.length, thumbnail_url: p.thumbnail_url, can_edit: p.can_edit })) });
    },
  },
  {
    name: "save_mockup_pack",
    description:
      "Bộ mockup: a new pack (no pack_id) or change one (pack_id; its maker or an admin) — only the fields given change. slides = the WHOLE list of scenes as list_mockup_packs {full: true} gives them (read, change, give back). Pictures for a scene: upload_mockup_pack_image first.",
    inputSchema: {
      type: "object",
      properties: {
        ...OPT_TASK_ARG,
        ...PACK_ID,
        name: { type: "string", description: "Pack name." },
        notes: { type: "string", description: "Notes." },
        slides: { type: "array", items: { type: "object" }, description: "Every scene: {id, name, width, height, layers: [...]} as the list gives." },
        thumbnail_url: { type: "string", description: "Its card picture ('' = none)." },
      },
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = str(args.pack_id);
      if (!id) {
        if (!str(args.name).trim()) throw new Error("name is empty");
        return json(await answer(await packs.createPack(s, packBody(args))));
      }
      idOf(args, "pack_id");
      await mayChange(ctx, s, CT_TABLES.mockupPacks, id, "mockup pack");
      const { data: was } = await s.supabase.from(CT_TABLES.mockupPacks).select("name, notes, slides, thumbnail_url").eq("id", id).single<CtMockupPackBody>();
      return json(await answer(await packs.updatePack(s, id, packBody(args, was ?? undefined))));
    },
  },
  {
    name: "delete_mockup_pack",
    description: "Bộ mockup: delete a pack (its maker or an admin). Cannot be undone: confirm must be true, and ask the editor first.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, ...PACK_ID, confirm: { type: "boolean", description: "true = really delete." } }, required: ["pack_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = idOf(args, "pack_id");
      await mayChange(ctx, s, CT_TABLES.mockupPacks, id, "mockup pack");
      if (args.confirm !== true) throw new Error("Not deleted: confirm must be true (ask the editor first)");
      await answer(await packs.deletePack(s, id));
      return json({ deleted: true, pack_id: id });
    },
  },
  {
    name: "upload_mockup_pack_image",
    description: "Bộ mockup: a picture for a scene (background, overlay, card) stored → {url, width, height} to put in save_mockup_pack's slides.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, ...IMAGE_IN, name: { type: "string", description: "File name (optional)." } } },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const form = new FormData();
      form.set("file", new File([new Uint8Array(await fileOf(args))], str(args.name) || "scene.png"));
      return json(await answer(await packs.uploadPackImage(s, form)));
    },
  },
  // ---------------------------------------------------------------- thư viện ảnh mockup
  {
    name: "list_pack_images",
    description: "Thư viện ảnh mockup: search the pictures (newest first) — q = words in the name / description, mine = only my uploads, collection_id = one collection.",
    inputSchema: {
      type: "object",
      properties: { ...OPT_TASK_ARG, q: { type: "string", description: "Words to find." }, mine: { type: "boolean", description: "Only my uploads." }, collection_id: { type: "string", description: "One collection." }, limit: { type: "number", description: "1–500, default 100." } },
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const params = new URLSearchParams();
      if (str(args.q)) params.set("q", str(args.q));
      if (args.mine === true) params.set("scope", "mine");
      if (str(args.collection_id)) params.set("collection", str(args.collection_id));
      params.set("limit", String(typeof args.limit === "number" ? args.limit : 100));
      return json(await answer(await packImages.listPackImages(await session(ctx, args), params)));
    },
  },
  {
    name: "get_pack_image",
    description: "Thư viện ảnh mockup: one picture (url, size, name, description, who made it).",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, image_id: { type: "string", description: "From list_pack_images." } }, required: ["image_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => json(await answer(await packImages.getPackImage(await session(ctx, args), idOf(args, "image_id")))),
  },
  {
    name: "upload_pack_image",
    description: "Thư viện ảnh mockup: add a picture (the page's upload) → the picture.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, ...IMAGE_IN, name: { type: "string", description: "Its name." } } },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const form = new FormData();
      form.set("file", new File([new Uint8Array(await fileOf(args))], "image"));
      form.set("name", str(args.name) || "Ảnh");
      return json(await answer(await packImages.uploadPackLibraryImage(s, form)));
    },
  },
  {
    name: "delete_pack_image",
    description: "Thư viện ảnh mockup: delete a picture and its file (its maker or an admin). Cannot be undone: confirm must be true.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, image_id: { type: "string", description: "From list_pack_images." }, confirm: { type: "boolean", description: "true = really delete." } }, required: ["image_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = idOf(args, "image_id");
      await mayChange(ctx, s, CT_TABLES.packImages, id, "picture");
      if (args.confirm !== true) throw new Error("Not deleted: confirm must be true (ask the editor first)");
      await answer(await packImages.deletePackImage(s, id));
      return json({ deleted: true, image_id: id });
    },
  },
  // ---------------------------------------------------------------- sample customers, presets
  {
    name: "mockup_sample_photos",
    description:
      "Ảnh mẫu người / thú for a photo zone (the Mockups tab's random custom samples): one different sample person / pet per item, drawn through the item's style like a customer's photo — what the random custom mockups put in that zone. Draws with the AI (costs one picture per item). → {samples: [{style, name, url, …}]}; nothing is saved on the product.",
    inputSchema: {
      type: "object",
      properties: {
        ...OPT_TASK_ARG,
        product_id: { type: "string", description: "The product (or its artwork's zone)." },
        region_id: { type: "string", description: "The photo zone (get_product_design → regions, kind photo)." },
        items: { type: "array", items: { type: "object" }, description: "[{style: a photo style ref of the zone (\"ai:<id>\" / \"face\" …), name?: the name it writes}] ≤ 8." },
      },
      required: ["product_id", "region_id", "items"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const items = Array.isArray(args.items) ? args.items.slice(0, 8) : [];
      if (!items.length) throw new Error("items is empty");
      return json(await answer(await mockupSamples(await session(ctx, args), idOf(args, "product_id"), { regionId: str(args.region_id), items })));
    },
  },
  {
    name: "list_presets",
    description: "Material presets (read-only, as the editor's pickers show them): kind = name | vật liệu | versions … ('' = every kind).",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, kind: { type: "string", description: "Only this kind (optional)." } } },
    callers: ["agent", "user"],
    run: async (ctx, args) => json(await answer(await listPresets(await session(ctx, args), str(args.kind) || null))),
  },
];
