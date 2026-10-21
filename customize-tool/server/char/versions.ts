/**
 * A lineup drawn version by version (brief.lineup.drawn, asked 2026-10-19: grandma + 1 grandchild cut out of the row of
 * five looked patchy — "mỗi số cháu một tấm ảnh khác nhau"). The set itself is the biggest version (every subject);
 * each smaller version is a VERSION SET — a set of its own (brief.versionOf), not listed on /v2, with its own master
 * (drawn from the approved one, the same characters), doll, 3b pictures and cut. The product takes each version's
 * layers from its own set (server/char/product.ts).
 *
 *   parent master approved → startVersionSets: a version set per smaller version + 2 masters each (in the background)
 *   a version's master approved → runVersionChain: 3a → every 3b picture → 3c regions → files, on its own
 *   3b plan: a version set follows its parent's (brief.pictures, lib/char-pictures.ts — the characters it lacks dropped)
 *   unless the agent wrote one for it (versionOf.ownPictures)
 *   every set of the lineup cut → remakeDrawnProduct: the parent's product, all versions in it
 */

import { NextResponse } from "next/server";
import { CT_TABLES } from "../../config";
import type { CtCharBrief, CtCharImage, CtCharProject, CtCharVersionCard } from "../../types";
import type { CtSession } from "../supabase";
import { masterPrompt, parseCharBrief } from "../../lib/char-brief";
import { charVersions } from "../../lib/char-lineup";
import { isThumbRole, planEdits } from "../../lib/char-plan";
import { latestEditsOf } from "../../lib/char-images";
import { fetchImage, saveCharFile } from "./files";
import { drawMasters, jsonError, loadImages, loadProject, type Db } from "./projects";
import { runEditRoles } from "./layers";
import { startMatte, startPlan } from "./cut";
import { remakeSetProduct, serviceSession, versionSetsOf } from "./product";
import { createAgentTask } from "../agent/tasks";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the version set's master is told on top of the brief: the approved master of the whole set is reference 1. */
export const VERSION_REF_NOTE =
  "The approved design with every character: draw the SAME characters exactly — faces, hair, outfits, colours, line work, proportions and how big each one is next to the others — only the ones listed, in this arrangement.";

/** A version set's master prompt: the brief's, opened by how many are in it (the reference shows more). */
export function versionMasterPrompt(brief: CtCharBrief): string {
  const n = brief.subjects.length;
  return `Draw EXACTLY ${n} characters — the reference picture shows more people: leave every other one out entirely, and lay these ${n} out anew as described.\n${masterPrompt(brief)}`;
}

/** The brief of version `index` of `parent`: its subjects only, no product parts (texts, decorations, backgrounds and
 * mockups are the parent's), drawn from the parent's master. */
function versionBrief(parent: CtCharProject, index: number, refId: string): CtCharBrief {
  const v = charVersions(parent.brief)[index];
  const b = parent.brief;
  return parseCharBrief({
    ...b,
    subjects: v.subjects.map((i) => b.subjects[i]),
    lineup: null,
    versionOf: { id: parent.id, name: v.name, index },
    // "character", not "sample": a sample's layout was copied — versions of 1 and 2 grandchildren came back with all
    // five people (2026-10-19).
    refs: [{ id: refId, use: "character", note: VERSION_REF_NOTE }],
    scene: `${v.subjects.length} people in this picture, nobody else: ${v.subjects.map((i) => b.subjects[i].name || b.subjects[i].description.split(/[,.;]/)[0]).join(", ")} (left to right). The pose and look of everyone as in this description: ${b.scene}`.slice(0, 1000),
    texts: [],
    elements: [],
    backdrops: [],
    mockups: [],
    charactersBox: null,
    choosers: (b.choosers ?? []).filter((c) => !c.subject || v.subjects.some((i) => b.subjects[i].id === c.subject)),
  });
}

/**
 * The version sets of a drawn lineup whose master was just approved: the missing ones made (named after the parent and
 * the version), each with the parent's master as its reference and 2 masters drawn. → every version set.
 */
export async function startVersionSets(db: Db, userId: string, parent: CtCharProject): Promise<CtCharProject[]> {
  if (parent.brief.lineup?.drawn !== true || !parent.master_id) return [];
  const versions = charVersions(parent.brief);
  if (versions.length < 2) return [];
  const have = await versionSetsOf(db, parent.id);
  const { data: master } = await db.from(CT_TABLES.charImages).select("*").eq("id", parent.master_id).single<CtCharImage>();
  if (!master?.url) throw new Error("Không thấy master đã duyệt");
  const out: CtCharProject[] = [];
  // The biggest version is the parent itself.
  for (let i = 0; i < versions.length - 1; i++) {
    const old = have.find((x) => x.brief.versionOf?.index === i);
    if (old) {
      out.push(old);
      continue;
    }
    const name = `${parent.name} — ${parent.brief.lineup.label}: ${versions[i].name}`.slice(0, 200);
    const { data: p, error } = await db.from(CT_TABLES.charProjects).insert({ user_id: parent.user_id ?? userId, name, brief: parseCharBrief({ versionOf: { id: parent.id, name: versions[i].name, index: i } }) }).select("*").single<CtCharProject>();
    if (error || !p) throw new Error(error?.message ?? "Không tạo được bộ phiên bản");
    // Its own copy of the parent's master (a set's pictures go when the set is deleted).
    const saved = await saveCharFile(p.user_id ?? userId, p.id, "ref", await fetchImage(master.url));
    const { data: ref } = await db.from(CT_TABLES.charImages).insert({ project_id: p.id, user_id: p.user_id ?? userId, kind: "ref", role: "ref", status: "done", ...saved }).select("*").single<CtCharImage>();
    if (!ref) throw new Error("Không lưu được ảnh tham khảo");
    const brief = versionBrief(parent, i, ref.id);
    const { data: row, error: e2 } = await db.from(CT_TABLES.charProjects).update({ brief }).eq("id", p.id).select("*").single<CtCharProject>();
    if (e2 || !row) throw new Error(e2?.message ?? "Không lưu được brief");
    await drawMasters(db, userId, row, { prompt: versionMasterPrompt(brief), count: 2 });
    out.push(row);
  }
  return out;
}

async function waitFor(db: Db, id: string, done: (p: CtCharProject, images: CtCharImage[]) => boolean, minutes: number): Promise<{ p: CtCharProject; images: CtCharImage[] }> {
  const deadline = Date.now() + minutes * 60_000;
  for (;;) {
    const p = await loadProject(db, id);
    if (!p) throw new Error("Bộ phiên bản đã bị xoá");
    const images = await loadImages(db, id);
    if (done(p, images)) return { p, images };
    if (Date.now() > deadline) throw new Error(`Quá ${minutes} phút`);
    await sleep(5_000);
  }
}

/** The 3b roles the cut needs whose newest picture is not done (failed / missing), and whether any still runs. */
function editState(p: CtCharProject, images: CtCharImage[]): { missing: string[]; running: boolean } {
  const latest = latestEditsOf(images);
  const plan = planEdits(p.brief).filter((e) => !isThumbRole(e.role));
  return { missing: plan.filter((e) => latest.get(e.role)?.status !== "done").map((e) => e.role), running: plan.some((e) => latest.get(e.role)?.status === "running") };
}

/** A version set without a 3b plan of its own takes its parent's current one (written after the version was made). */
export async function followParentPlan(db: Db, p: CtCharProject): Promise<CtCharProject> {
  const of = p.brief.versionOf;
  if (!of || of.ownPictures) return p;
  const parent = await loadProject(db, of.id);
  const pictures = parent?.brief.pictures ?? null;
  if (JSON.stringify(pictures) === JSON.stringify(p.brief.pictures ?? null)) return p;
  const brief = { ...p.brief, pictures };
  const { error } = await db.from(CT_TABLES.charProjects).update({ brief }).eq("id", p.id);
  if (error) throw new Error(error.message);
  return { ...p, brief };
}

/** Busy chains, so a second approval does not start another. */
const chains = new Set<string>();

/**
 * Everything after a version set's master, on its own (the parent's agent checks the pictures and redraws a wrong one
 * with set_id): 3a, every 3b picture (a failed one asked again once), the 3c regions and the files. Never throws.
 */
export async function runVersionChain(db: Db, userId: string, id: string): Promise<void> {
  if (chains.has(id)) return;
  chains.add(id);
  try {
    let { p } = await waitFor(db, id, () => true, 1);
    if (!p.master_id || !p.brief.versionOf) return;
    p = await followParentPlan(db, p);
    if (p.cut?.matte?.status !== "done") {
      if (p.cut?.matte?.status !== "running") p = await startMatte(db, userId, p);
      ({ p } = await waitFor(db, id, (x) => x.cut?.matte?.status !== "running", 30));
      if (p.cut?.matte?.status !== "done") throw new Error(`3a: ${p.cut?.matte?.error ?? "lỗi"}`);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const images = await loadImages(db, id);
      const { missing, running } = editState(p, images);
      if (!missing.length) break;
      if (!running) await runEditRoles(db, userId, p, { roles: attempt === 0 ? null : missing });
      ({ p } = await waitFor(db, id, (x, ims) => !editState(x, ims).running, 90));
    }
    const left = editState(p, await loadImages(db, id)).missing;
    if (left.length) throw new Error(`3b chưa đủ ảnh: ${left.join(", ")}`);
    await startPlan(db, userId, p, true);
    ({ p } = await waitFor(db, id, (x) => x.cut?.plan?.status !== "running" && x.layers?.status !== "building", 90));
    if (p.cut?.plan?.status === "failed") throw new Error(`3c: ${p.cut.plan.error}`);
  } catch (e) {
    console.warn(`[ct] version chain ${id}:`, e instanceof Error ? e.message : String(e));
  } finally {
    chains.delete(id);
  }
}

/**
 * The parent's product, once every set of the lineup is cut (the parent's own files + each version set's). Called
 * when any of them finishes a cut; does nothing while one is still missing. → the product id, or null.
 */
export async function remakeDrawnProduct(db: Db, userId: string, parentId: string): Promise<string | null> {
  // One build at a time per lineup: several sets finishing their cut together each asked for one, and the builds
  // deleted each other's products half-way (2026-10-19). Asked while one runs → once more after it.
  const busy = building.get(parentId);
  if (busy) {
    again.add(parentId);
    return busy;
  }
  const run = (async () => {
    let id: string | null = null;
    do {
      again.delete(parentId);
      id = await buildDrawnProduct(db, userId, parentId);
    } while (again.has(parentId));
    return id;
  })().finally(() => building.delete(parentId));
  building.set(parentId, run);
  return run;
}

/** A chat task for @flexiprint on a posed set whose poses are all cut: compose the versions, then step 4. */
async function askToCompose(db: Db, userId: string, parent: CtCharProject): Promise<void> {
  const { data: open } = await db.from(CT_TABLES.agentTasks).select("id").eq("kind", "char").eq("input->char->>projectId", parent.id).in("status", ["pending", "running", "waiting"]).limit(1);
  if (open?.length) return;
  const s = await serviceSession(db, userId);
  const request =
    "Mọi dáng đã cắt xong, sản phẩm đã dựng tạm (mọi người đứng cạnh nhau). Ghép từng phiên bản bằng char_compose cho giống ảnh mẫu (ai ở giữa, cao thấp, ai đứng trước, lật gương), render_artwork từng phiên bản để kiểm tra, rồi làm bước 4: phần tử (biển), nền nếu có, char_remake_product và mockup. Tự làm hết, không cần hỏi.";
  const res = await createAgentTask(s, { kind: "char", input: { char: { projectId: parent.id, step: "chat", request, roles: [], tab: "product", section: "" } } });
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => "")}`.slice(0, 300));
}

const building = new Map<string, Promise<string | null>>();
const again = new Set<string>();

async function buildDrawnProduct(db: Db, userId: string, parentId: string): Promise<string | null> {
  const parent = await loadProject(db, parentId);
  // Every character drawn in its own pose: the product once every pose set is cut (composed from them).
  if (parent?.brief.poses?.length) {
    const kids = await versionSetsOf(db, parentId);
    if (parent.brief.poses.some((po) => kids.find((k) => k.brief.versionOf?.pose === po.id)?.layers?.status !== "done")) return null;
    const productId = await remakeSetProduct(db, parent.user_id ?? userId, parent, null);
    await db.from(CT_TABLES.charProjects).update({ product_ids: [productId], status: "product" }).eq("id", parentId);
    // The first build has everyone side by side: @flexiprint composes the versions like the sample (unless it is
    // already working on the set).
    if (!parent.brief.compose?.length) await askToCompose(db, parent.user_id ?? userId, parent).catch((e: Error) => console.warn("[ct] compose task", e.message));
    return productId;
  }
  if (!parent?.brief.lineup?.drawn || parent.layers?.status !== "done") return null;
  const children = await versionSetsOf(db, parentId);
  const need = charVersions(parent.brief).length - 1;
  if (children.length < need || children.some((c) => c.layers?.status !== "done")) return null;
  const productId = await remakeSetProduct(db, parent.user_id ?? userId, parent, { ...parent.layers, approved: true });
  await db.from(CT_TABLES.charProjects).update({ layers: { ...parent.layers, approved: true }, product_ids: [productId], status: "product" }).eq("id", parentId);
  return productId;
}

/** GET char/projects/:id/versions — the version sets of a drawn lineup, for the parent's page. */
export async function listVersionSets(s: CtSession, id: string): Promise<NextResponse> {
  const p = await loadProject(s.supabase, id);
  if (!p) return jsonError("Không tìm thấy bộ nhân vật", 404);
  const kids = await versionSetsOf(s.supabase, id);
  const versions: CtCharVersionCard[] = await Promise.all(
    kids.map(async (k) => {
      const images = await loadImages(s.supabase, k.id);
      const latest = latestEditsOf(images);
      const plan = k.master_id ? planEdits(k.brief).filter((e) => !isThumbRole(e.role)) : [];
      const st = (st: string) => plan.filter((e) => latest.get(e.role)?.status === st).length;
      return {
        project: k,
        masters: images.filter((im) => im.kind === "master").map((m) => ({ id: m.id, status: m.status, thumbUrl: m.thumb_url || m.url, url: m.url })),
        edits: { done: st("done"), total: plan.length, running: st("running"), failed: st("failed") },
      };
    }),
  );
  return NextResponse.json({ versions });
}
