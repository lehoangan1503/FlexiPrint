/**
 * char/* routes (v2 bộ nhân vật) — see server/char/projects.ts for the list.
 */

import type { NextRequest, NextResponse } from "next/server";
import type { CtSession } from "../supabase";
import type { CtCharProject } from "../../types";
import { parseCharBrief } from "../../lib/char-brief";
import { recordEdit } from "../agent/inbox";
import { approveCharLayers, buildCharLayers, layerFileRoute, startEdits } from "./layers";
import { cutRoute, startMatte } from "./cut";
import { behindStageRoute, behindRoute } from "./behind";
import { createAgentTask } from "../agent/tasks";
import { createCharProduct, remakeCharProduct } from "./product";
import { makeCharBlank } from "./blank";
import { backdropsRoute } from "./backdrops";
import { elementsRoute } from "./elements";
import { photoStylesRoute } from "./photo-styles";
import { charKhuonRoute } from "./khuon";
import { listVersionSets, runVersionChain, startVersionSets } from "./versions";
import { productSets, setProducts } from "./set-users";
import { createImport, importRoute } from "./import";
import { adoptMaster, approveMaster, createCharProject, deleteCharProject, generateMasters, getCharProject, jobDb, jsonError, listCharProjects, loadProject, refineMaster, updateCharProject, uploadCharFile, uploadChatFile } from "./projects";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function json(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

/** path = ["char", "projects", id?, action?, sub?, subAction?] — a change made here while @flexiprint works on the bộ is
 * told to it (server/agent/inbox.ts recordEdit: the agent reads it with its next tool call). */
export async function dispatchChar(req: NextRequest, s: CtSession, path: string[]): Promise<NextResponse> {
  const [, , id, action] = path;
  const watched = req.method !== "GET" && req.method !== "DELETE" && !!id && UUID.test(id) && action !== "chat-files" && action !== "versions" && action !== "import";
  if (!watched) return route(req, s, path);
  const before = await loadProject(s.supabase, id).catch(() => null);
  const body = (req.headers.get("content-type") ?? "").includes("application/json") ? await req.clone().json().catch(() => null) : null;
  const res = await route(req, s, path);
  if (res.ok && before) {
    const text = editText(before, path, req.method, body);
    if (text) await recordEdit(s.user.id, id, before.brief.versionOf?.id ?? null, text).catch((e: Error) => console.warn("[ct] inbox edit", e.message));
  }
  return res;
}

/** A hand change, in words for the agent. */
function editText(p: CtCharProject, path: string[], method: string, raw: unknown): string {
  const [, , , action, sub, subAction] = path;
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const fileName = (imageId: unknown) => {
    for (const sl of p.layers?.slots ?? [])
      for (const f of sl.files) if (f.imageId === imageId) return `${sl.label}: ${[f.option, f.color].filter(Boolean).join(" · ")} (image ${f.imageId})`;
    return `image ${String(imageId)}`;
  };
  if (method === "PATCH") {
    if (b.brief === undefined) return typeof b.name === "string" ? `Đổi tên bộ thành "${b.name}"` : "";
    const was = parseCharBrief(p.brief) as unknown as Record<string, unknown>;
    const now = parseCharBrief(b.brief) as unknown as Record<string, unknown>;
    const keys = Object.keys(now).filter((k) => k !== "pictures" && JSON.stringify(now[k]) !== JSON.stringify(was[k]));
    return keys.length ? `Sửa brief (bước 1) — các mục đổi: ${keys.join(", ")}` : "";
  }
  if (action === "photo-styles") {
    if (method === "GET") return "";
    if (method === "DELETE") return `Bỏ style ảnh khách ${sub ?? ""} (sửa tay)`;
    if (sub === "test") return `Bấm thử style ảnh khách${Array.isArray(b.styleIds) && b.styleIds.length ? `: ${b.styleIds.join(", ")}` : " (mọi style)"}`;
    if (sub === "demo") return `Chọn ảnh ${String(b.imageId)} làm demo của style ${String(b.styleId)}`;
    if (sub === "photos") return "Đổi ảnh thử của style ảnh khách";
    if (sub === "order") return "Đổi thứ tự style ảnh khách";
    return `${typeof b.id === "string" ? "Sửa" : "Thêm"} style ảnh khách "${String(b.name ?? "")}" (sửa tay)${typeof b.prompt === "string" ? ` — prompt: ${b.prompt.slice(0, 400)}` : ""}`;
  }
  if (action === "files") return "Tải ảnh lên bộ";
  if (action === "masters" && !sub) return "Bấm vẽ thêm master (bước 2)";
  if (action === "masters" && subAction === "refine") return `Sửa master ${sub} (refine)${typeof b.prompt === "string" ? `: ${b.prompt.slice(0, 300)}` : ""}`;
  if (action === "masters" && subAction === "adopt") return `Dùng master ${sub}`;
  if (action === "approve") return typeof b.imageId === "string" ? `Duyệt master ${b.imageId}` : "Bỏ duyệt master";
  if (action === "edits") return `Chạy lại ảnh 3b${Array.isArray(b.roles) && b.roles.length ? `: ${b.roles.join(", ")}` : ""}`;
  if (action === "layers" && !sub) return "Bấm cắt lại / tạo bộ custom (3c)";
  if (action === "layers" && sub === "approve") return "Duyệt bộ file (3c)";
  if (action === "layers" && sub === "file") {
    if (subAction === "revert") return `Hoàn tác sửa tay clipart ${fileName(b.imageId)}`;
    const move = b.move && typeof b.move === "object" ? (b.move as { dx?: unknown; dy?: unknown }) : null;
    return `Sửa tay clipart ${fileName(b.imageId)}${b.mask ? " (vẽ lại vùng: cọ / tẩy)" : ""}${move && (Number(move.dx) || Number(move.dy)) ? ` (kéo ${Number(move.dx) || 0}, ${Number(move.dy) || 0} px)` : ""} — mọi màu của kiểu đó đổi theo`;
  }
  if (action === "layers" && sub === "behind" && subAction === "stage") return "";
  if (action === "layers" && sub === "behind") return `${b.mask ? "Vẽ" : "Bỏ"} phần nằm sau của layer ${String(b.slot)} (sửa tay) — phần đó nằm dưới mọi nhân vật, sản phẩm bộ cha dựng lại`;
  if (action === "plan") return `Vùng lớp 3c: ${sub ?? ""}${typeof b.key === "string" ? ` ${b.key}` : ""} (sửa tay)`;
  if (action === "matte") return `Master cỡ in 3a: ${sub ?? ""} (sửa tay)`;
  if (action === "products") return sub === "remake" ? "Bấm làm lại sản phẩm" : "Bấm tạo sản phẩm";
  if (action === "backdrops" || action === "elements" || action === "khuon" || action === "blank") return `Bước 4: ${action}${typeof b.action === "string" ? ` ${b.action}` : ""} (bấm tay trên editor)`;
  return "";
}

async function route(req: NextRequest, s: CtSession, path: string[]): Promise<NextResponse> {
  const [, coll, id, action, sub, subAction] = path;
  const method = req.method;
  if (coll !== "projects") return jsonError("Not found", 404);
  if (!id) {
    const product = new URL(req.url).searchParams.get("product");
    if (method === "GET" && product) return UUID.test(product) ? productSets(s, product) : jsonError("id không hợp lệ", 400);
    if (method === "GET") return listCharProjects(s);
    if (method === "POST") return createCharProject(s, await json(req));
    return jsonError("Not found", 404);
  }
  // A finished bộ imported from its files (server/char/import.ts).
  if (id === "import" && !action && method === "POST") return createImport(s, await json(req));
  if (!UUID.test(id)) return jsonError("id không hợp lệ", 400);
  if (action === "import" && sub && !subAction && method === "POST") return importRoute(req, s, id, sub);
  if (action === "versions" && !sub && method === "GET") return listVersionSets(s, id);
  if (action === "used-by" && !sub && method === "GET") return setProducts(s, id);
  if (!action) {
    if (method === "GET") return getCharProject(s, id);
    if (method === "PATCH") return updateCharProject(s, id, await json(req));
    if (method === "DELETE") return deleteCharProject(s, id);
  }
  // A bộ ảnh khách's own AI styles (asked 2026-10-28).
  if (action === "photo-styles" && !subAction) return photoStylesRoute(s, method, id, sub ?? "", method === "GET" || method === "DELETE" ? null : await json(req));
  if (method !== "POST") return jsonError("Not found", 404);
  if (action === "files" && !sub) return uploadCharFile(s, id, await req.formData());
  if (action === "chat-files" && !sub) return uploadChatFile(s, id, await req.formData());
  if (action === "masters" && !sub) return generateMasters(s, id, await json(req));
  if (action === "masters" && sub && UUID.test(sub) && subAction === "refine") return refineMaster(s, id, sub, await json(req));
  if (action === "masters" && sub && UUID.test(sub) && subAction === "adopt") return adoptMaster(s, id, sub);
  if (action === "approve" && !sub) {
    const body = await json(req);
    const res = await approveMaster(s, id, body);
    // A master approved: its print-size cut-out (3a) starts. The khuôn in / phôi trơn are product things — made only
    // when asked in step 4 (asked 2026-10-13: nothing about the product runs on its own).
    if (res.ok && body && typeof body === "object" && typeof (body as { imageId?: unknown }).imageId === "string") {
      const p = await loadProject(s.supabase, id);
      // A bộ ảnh khách has no cut: its pieces are drawn on their own (server/char/elements.ts).
      // A version set (one version of a lineup drawn version by version) goes on by itself: 3a → 3b → 3c.
      if (p?.brief.versionOf) {
        void runVersionChain(jobDb(s), s.user.id, p.id);
        return res;
      }
      if (p && p.brief.kind !== "photo") {
        // The master at print size (3a) runs at once: nothing to review there any more (the AI's own cut-out).
        await startMatte(jobDb(s), s.user.id, p).catch((e: Error) => console.warn("[ct] char matte", e.message));
        // Each smaller version drawn as its own picture: its set + masters (the agent picks them).
        if (p.brief.lineup?.drawn) await startVersionSets(jobDb(s), s.user.id, p).catch((e: Error) => console.warn("[ct] char versions", e.message));
      }
      // Everything after the master is @flexiprint's, on its own (asked 2026-10-18): 3b → cut → step 4 → mockups,
      // checked at every stage. The editor watches; "Dừng" cancels it; changes are asked in the chat.
      if (p) {
        const started = await createAgentTask(s, { kind: "char", input: { char: { projectId: p.id, step: "auto", request: "", roles: [] } } });
        if (!started.ok) console.warn("[ct] char auto", started.status, await started.text().catch(() => ""));
      }
    }
    return res;
  }
  if (action === "blank" && !sub) return makeCharBlank(s, id);
  if (action === "backdrops" && !sub) return backdropsRoute(s, id, await json(req));
  if (action === "elements" && !sub) return elementsRoute(s, id, await json(req));
  if (action === "khuon" && !sub) return charKhuonRoute(s, id, (req.headers.get("content-type") ?? "").includes("multipart/form-data") ? await req.formData() : null);
  if (action === "edits" && !sub) return startEdits(s, id, await json(req));
  if (action === "layers" && !sub) return buildCharLayers(s, id, await json(req));
  if (action === "layers" && sub === "approve") return approveCharLayers(s, id, await json(req));
  if (action === "layers" && sub === "file" && (!subAction || subAction === "revert")) return layerFileRoute(s, id, subAction, await json(req));
  if (action === "layers" && sub === "behind" && !subAction) return behindRoute(s, id, await json(req));
  if (action === "layers" && sub === "behind" && subAction === "stage") return behindStageRoute(s, id, await json(req));
  if ((action === "matte" || action === "plan") && !subAction) return cutRoute(s, id, action, sub, await json(req));
  if (action === "products" && !sub) return createCharProduct(s, id, await json(req));
  if (action === "products" && sub === "remake") return remakeCharProduct(s, id);
  return jsonError("Not found", 404);
}
