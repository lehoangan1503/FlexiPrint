/**
 * A set whose characters are drawn alone, pose by pose (brief.poses, asked 2026-10-21: "tất cả búp bê nên vẽ độc lập" —
 * five people drawn in one picture got their hair and hats stuck to each other when cut). Each pose is a POSE SET
 * (brief.versionOf.pose, not listed on /v2): ONE character, big, on its own square canvas, with its own masters, doll,
 * 3b pictures and files — server/char/versions.ts runs it like a version set once its master is approved. The parent
 * set keeps the brief, the texts, the sign, the choosers; its product places the poses' files in every version as
 * brief.compose says (server/char/product.ts).
 *
 *   char_draw_poses → startPoseSets: a pose set per pose (the parent's references copied in) + 2 masters each
 *   a pose master approved → runVersionChain: 3a → 3b → 3c on its own
 *   every pose set cut → remakeDrawnProduct (versions.ts): the parent's product, composed
 */

import { CT_TABLES } from "../../config";
import type { CtCharBrief, CtCharImage, CtCharPose, CtCharProject, CtCharRef } from "../../types";
import { masterPrompt, parseCharBrief, poseProblems } from "../../lib/char-brief";
import { fetchImage, saveCharFile } from "./files";
import { drawMasters, loadImages, type Db } from "./projects";
import { versionSetsOf } from "./product";

/** What the pose master is told about a reference that shows the whole group. */
const poseRefNote = (who: string) => `The picture shows several characters: draw ONLY ONE of them — ${who} — alone, the same face, hair, outfit, colours, line work and proportions. Nobody else.`;

/** The brief of `pose` (index `index` of the parent's poses): the subject it is drawn as, alone, no product parts. */
export function poseBrief(parent: CtCharProject, pose: CtCharPose, index: number, refs: CtCharRef[]): CtCharBrief {
  const b = parent.brief;
  const sub = b.subjects.find((x) => x.id === pose.subjects[0]);
  if (!sub) throw new Error(`Dáng "${pose.name}": không có nhân vật ${pose.subjects[0]}`);
  const choosers = new Set(sub.slots.flatMap((sl) => [sl.shownWhen?.chooser, sl.follows].filter((x): x is string => !!x)));
  return parseCharBrief({
    ...b,
    subjects: [sub],
    lineup: null,
    poses: null,
    compose: null,
    pictures: null,
    versionOf: { id: parent.id, name: pose.name || sub.name || pose.id, index, pose: pose.id },
    refs,
    scene: `ONE character alone in the picture, nobody else, centred and as big as the square allows: ${pose.description}`.slice(0, 1000),
    texts: [],
    elements: [],
    backdrops: [],
    mockups: [],
    charactersBox: null,
    // The pose is drawn on its own square, never on the khuôn.
    product: { ...b.product, templateId: null, layout: "", blankId: null },
    choosers: (b.choosers ?? []).filter((c) => c.subject === sub.id || choosers.has(c.id)),
  });
}

/** The parent's references for a pose set: copied into it (a set's pictures go with it), the group ones told to take
 * one character; the parent's approved master too, when there is one (the same people). */
async function copyRefs(db: Db, userId: string, parent: CtCharProject, child: CtCharProject, who: string): Promise<CtCharRef[]> {
  const images = await loadImages(db, parent.id);
  const out: CtCharRef[] = [];
  const copy = async (url: string, use: CtCharRef["use"], note: string) => {
    const saved = await saveCharFile(child.user_id ?? userId, child.id, "ref", await fetchImage(url));
    const { data } = await db.from(CT_TABLES.charImages).insert({ project_id: child.id, user_id: child.user_id ?? userId, kind: "ref", role: "ref", status: "done", ...saved }).select("*").single<CtCharImage>();
    if (data) out.push({ id: data.id, use, note });
  };
  const master = parent.master_id ? images.find((im) => im.id === parent.master_id && im.status === "done") : undefined;
  if (master) await copy(master.url, "character", poseRefNote(who));
  for (const r of parent.brief.refs) {
    const im = images.find((x) => x.id === r.id && x.status === "done");
    if (!im || out.length >= 4) continue;
    // A sample shows the whole product: its look and these people, never its layout.
    await copy(im.url, r.use === "sample" ? "character" : r.use, r.use === "sample" || r.use === "character" ? `${poseRefNote(who)}${r.note ? ` ${r.note}` : ""}` : r.note);
  }
  return out;
}

/** The pose prompt: the brief's, with how the character must sit in its square (the same head size in every pose). */
export function poseMasterPrompt(brief: CtCharBrief): string {
  return `${masterPrompt(brief)}\nThe character fills the square: its head and hat about a third of the picture's height, centred, a small even margin around — every pose of this set is drawn at this same size.`;
}

/**
 * The pose sets of `parent` (brief.poses): the missing ones made, each with the parent's references and 2 masters
 * drawn; a pose that has one keeps it (its masters are redrawn with char_draw_masters set_id). → every pose set.
 */
export async function startPoseSets(db: Db, userId: string, parent: CtCharProject): Promise<CtCharProject[]> {
  const poses = parent.brief.poses ?? [];
  if (!poses.length) throw new Error("Brief chưa có dáng (brief.poses)");
  const problems = poseProblems(parent.brief);
  if (problems.length) throw new Error(problems.join(" · "));
  const have = await versionSetsOf(db, parent.id);
  const out: CtCharProject[] = [];
  for (const [i, pose] of poses.entries()) {
    const old = have.find((x) => x.brief.versionOf?.pose === pose.id);
    if (old) {
      out.push(old);
      continue;
    }
    const sub = parent.brief.subjects.find((x) => x.id === pose.subjects[0])!;
    const name = `${parent.name} — dáng: ${pose.name || sub.name || pose.id}`.slice(0, 200);
    const { data: p, error } = await db.from(CT_TABLES.charProjects).insert({ user_id: parent.user_id ?? userId, name, brief: parseCharBrief({ versionOf: { id: parent.id, name: pose.name, index: i, pose: pose.id } }) }).select("*").single<CtCharProject>();
    if (error || !p) throw new Error(error?.message ?? "Không tạo được bộ dáng");
    const who = `${sub.name ? `${sub.name}: ` : ""}${sub.description.split(/[.;]/)[0]}`;
    const refs = await copyRefs(db, userId, parent, p, who);
    const brief = poseBrief(parent, pose, i, refs);
    const { data: row, error: e2 } = await db.from(CT_TABLES.charProjects).update({ brief }).eq("id", p.id).select("*").single<CtCharProject>();
    if (e2 || !row) throw new Error(e2?.message ?? "Không lưu được brief");
    await drawMasters(db, userId, row, { prompt: poseMasterPrompt(brief), count: 2 });
    out.push(row);
  }
  return out;
}
