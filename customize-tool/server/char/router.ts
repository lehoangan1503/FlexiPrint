/**
 * char/* routes (v2 bộ nhân vật) — see server/char/projects.ts for the list.
 */

import type { NextRequest, NextResponse } from "next/server";
import type { CtSession } from "../supabase";
import { approveCharLayers, buildCharLayers, layerFileRoute, startEdits } from "./layers";
import { cutRoute, startMatte } from "./cut";
import { createAgentTask } from "../agent/tasks";
import { createCharProduct, remakeCharProduct } from "./product";
import { makeCharBlank } from "./blank";
import { backdropsRoute } from "./backdrops";
import { elementsRoute } from "./elements";
import { charKhuonRoute } from "./khuon";
import { adoptMaster, approveMaster, createCharProject, deleteCharProject, generateMasters, getCharProject, jobDb, jsonError, listCharProjects, loadProject, refineMaster, updateCharProject, uploadCharFile, uploadChatFile } from "./projects";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function json(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

/** path = ["char", "projects", id?, action?, sub?, subAction?] */
export async function dispatchChar(req: NextRequest, s: CtSession, path: string[]): Promise<NextResponse> {
  const [, coll, id, action, sub, subAction] = path;
  const method = req.method;
  if (coll !== "projects") return jsonError("Not found", 404);
  if (!id) {
    if (method === "GET") return listCharProjects(s);
    if (method === "POST") return createCharProject(s, await json(req));
    return jsonError("Not found", 404);
  }
  if (!UUID.test(id)) return jsonError("id không hợp lệ", 400);
  if (!action) {
    if (method === "GET") return getCharProject(s, id);
    if (method === "PATCH") return updateCharProject(s, id, await json(req));
    if (method === "DELETE") return deleteCharProject(s, id);
  }
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
      if (p && p.brief.kind !== "photo") {
        // The master at print size (3a) runs at once: nothing to review there any more (the AI's own cut-out).
        await startMatte(jobDb(s), s.user.id, p).catch((e: Error) => console.warn("[ct] char matte", e.message));
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
  if ((action === "matte" || action === "plan") && !subAction) return cutRoute(s, id, action, sub, await json(req));
  if (action === "products" && !sub) return createCharProduct(s, id, await json(req));
  if (action === "products" && sub === "remake") return remakeCharProduct(s, id);
  return jsonError("Not found", 404);
}
