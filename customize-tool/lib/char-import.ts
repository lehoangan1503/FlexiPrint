/**
 * Imported bộ (asked 2026-10-29): someone's own finished files — a Teeinblue export that already sells — become a bộ
 * nhân vật with its product, like a set drawn by AI. Every source format comes to one CtCharImportManifest; the server
 * builds the product from it (server/char/import.ts). Pure: no network.
 *
 *   readTeeinblue   the folder layout of a Teeinblue hand-off (n00-POD-02, 2026-10-29): one folder per case
 *                   (c<N>-<layout>) with teeinblue.json (layers bottom → top, static / choice, the names on the
 *                   stockings, which layer follows which) and print/ (every layer a whole-canvas PNG; a choice layer a
 *                   folder of its options). Notes beside it (o-chon-mac-dinh.md, title-description.txt) give the
 *                   defaults, the skin colours, the case names and the product text.
 *   parseManifest   a manifest @flexiprint wrote for any other folder (MCP char_import_build), checked.
 *
 * Layer rules (server/mcp/layer-rules.ts): files are used whole, never trimmed or scaled; a layer whose choice is set by
 * another (the head follows the body's skin + outfit; the hair under a hat follows the hat) is a LINKED layer with the
 * leader's groups mirrored, never a second customer choice.
 */

import type { CtCharImportFile, CtCharImportGroup, CtCharImportLayer, CtCharImportManifest, CtCharImportText, CtCharImportVariant, CtCharImportVersion } from "../types";
import { CT_MATERIALS } from "./materials";

type Obj = Record<string, unknown>;
const rec = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const txt = (v: unknown, max = 400): string => (typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : 0);

const base = (path: string) => path.split("/").pop() ?? path;
const dir = (path: string) => path.split("/").slice(0, -1).join("/");
const stem = (path: string) => base(path).replace(/\.[^.]+$/, "");
const isImage = (path: string) => /\.(png|webp|jpe?g)$/i.test(path);
/** "c10" after "c9". */
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** Font weight words of a font name ("Baloo 2 ExtraBold" → "Baloo 2", 800). */
const WEIGHTS: Array<[RegExp, number]> = [
  [/\s*(extra|ultra)[\s-]?bold$/i, 800],
  [/\s*(semi|demi)[\s-]?bold$/i, 600],
  [/\s*bold$/i, 700],
  [/\s*black$/i, 900],
  [/\s*(extra|ultra)[\s-]?light$/i, 200],
  [/\s*light$/i, 300],
  [/\s*thin$/i, 100],
  [/\s*medium$/i, 500],
  [/\s*regular$/i, 400],
];
export function fontOf(name: string): { family: string; weight: number } {
  const n = name.trim();
  for (const [re, w] of WEIGHTS) if (re.test(n)) return { family: n.replace(re, "").trim(), weight: w };
  return { family: n, weight: 400 };
}

/** Customer-facing words for the parts' Vietnamese names in file and layer names (a set's labels can be edited after). */
const WORDS: Record<string, string> = {
  chau: "Grandkid",
  ba: "Grandma",
  ong: "Grandpa",
  be: "Baby",
  me: "Mom",
  bo: "Dad",
  than: "Outfit",
  ao: "Outfit",
  dau: "Head",
  mat: "Face",
  toc: "Hair",
  mu: "Hat",
  non: "Hat",
  ten: "Name",
  da: "Skin",
  nen: "Background",
  bong: "Shadow",
  tham: "Rug",
};
const cap = (x: string) => (x ? x[0].toUpperCase() + x.slice(1) : x);

/** "da1" → "Skin 1", "nam-nau" → "Nam nau". */
function tokenName(token: string): string {
  const m = /^([a-z]+)(\d+)$/i.exec(token);
  if (m && WORDS[m[1].toLowerCase()]) return `${WORDS[m[1].toLowerCase()]} ${m[2]}`;
  return cap(token.replace(/[-_]+/g, " "));
}

/** "02-chau1-than" → "Grandkid 1 — Outfit"; "06-ba-toc" → "Grandma — Hair". */
export function layerLabel(key: string): string {
  const words = key.replace(/^\d+[-_ ]*/, "").split(/[-_ ]+/).filter(Boolean);
  const named = words.map((w) => {
    const m = /^([a-z]+)(\d+)$/i.exec(w);
    if (m && WORDS[m[1].toLowerCase()]) return `${WORDS[m[1].toLowerCase()]} ${m[2]}`;
    return WORDS[w.toLowerCase()] ?? cap(w);
  });
  if (named.length < 2) return named[0] ?? key;
  return `${named.slice(0, -1).join(" ")} — ${named[named.length - 1]}`;
}

/** An option's name from its file: what is left once the prefix every option of the layer shares is taken off. */
function optionNames(stems: string[]): string[] {
  if (stems.length < 2) return stems.map((x) => cap(x.replace(/[-_]+/g, " ")));
  const parts = stems.map((x) => x.split("-"));
  let k = 0;
  while (parts.every((p) => p.length > k + 1 && p[k] === parts[0][k])) k++;
  return parts.map((p) => cap(p.slice(k).join(" ")));
}

/** The text files the importer reads (json / md / txt / csv): path → contents. */
export type CtImportTexts = Map<string, string>;

export interface CtImportRead {
  manifest: CtCharImportManifest;
  summary: string[];
  problems: string[];
}

/** Notes beside the cases (o-chon-mac-dinh.md and the like). */
interface Notes {
  /** case → layer key → default file stem. */
  defaults: Map<string, Map<string, string>>;
  /** case → its name ("2 cháu, bà bế bé trong lòng"). */
  caseNames: Map<string, string>;
  /** token → #hex ("da1" → "#fabaa0"). */
  swatches: Map<string, string>;
  maxChars: number;
}

function readNotes(texts: CtImportTexts): Notes {
  const defaults = new Map<string, Map<string, string>>();
  const caseNames = new Map<string, string>();
  const swatches = new Map<string, string>();
  let maxChars = 0;
  for (const [path, body] of texts) {
    if (!/\.(md|txt)$/i.test(path)) continue;
    let section = "";
    for (const line of body.split(/\r?\n/)) {
      // "## c1-trong — 1 cháu, cháu ngồi quanh bà · bảng …"
      const h = /^#{2,4}\s+([a-z]\d+(?:-[\w]+)?)\s+[—–-]\s+([^·]+)/i.exec(line);
      if (h) {
        section = h[1];
        caseNames.set(section, h[2].trim());
        continue;
      }
      // "| 02-chau1-than | quay phải | 36 | chau-than-da1-chau-ao-goc |"
      const row = section ? /^\|\s*(\d+-[\w-]+)\s*\|.*\|\s*([\w-]+)\s*\|\s*$/.exec(line) : null;
      if (row) {
        const m = defaults.get(section) ?? new Map<string, string>();
        m.set(row[1], row[2]);
        defaults.set(section, m);
      }
      for (const sw of line.matchAll(/\b([a-z]+\d+)\s+(#[0-9a-f]{6})\b/gi)) swatches.set(sw[1].toLowerCase(), sw[2].toLowerCase());
      const mc = /tối đa (?:khoảng )?(\d+) ký tự|up to (?:about )?(\d+) characters/i.exec(line);
      if (mc) maxChars = Math.max(maxChars, Number(mc[1] ?? mc[2]));
    }
  }
  return { defaults, caseNames, swatches, maxChars };
}

/** TITLE / DESCRIPTION of a sales text file. */
function salesText(texts: CtImportTexts): { title: string; description: string } {
  for (const [, body] of texts) {
    const m = /^\s*TITLE\s*\n([\s\S]*?)\n\s*DESCRIPTION\s*\n([\s\S]*)$/i.exec(body);
    if (m) return { title: m[1].trim().slice(0, 300), description: m[2].trim().slice(0, 8000) };
  }
  return { title: "", description: "" };
}

/**
 * A choice layer's options in groups: the part of the name that takes a few values, each with the SAME options
 * ("da1 / da2 / da4" × 12 outfits) → one group per value; else one group.
 */
function grouped(stems: string[], ownToken: string): Array<{ token: string; stems: string[] }> {
  const toks = stems.map((x) => x.split("-").filter((t) => t !== ownToken));
  const width = Math.min(...toks.map((t) => t.length));
  for (let i = 0; i < width; i++) {
    const values = [...new Set(toks.map((t) => t[i]))];
    if (values.length < 2 || values.length > 12 || values.length === stems.length) continue;
    const rest = (t: string[]) => [...t.slice(0, i), ...t.slice(i + 1)].join("-");
    const sets = values.map((v) => toks.filter((t) => t[i] === v).map(rest).sort().join("|"));
    if (sets.every((x) => x === sets[0])) {
      // Every group in the same option order (the first group's).
      const order = toks.filter((t) => t[i] === values[0]).map(rest);
      return values.map((v) => ({ token: v, stems: order.map((r) => stems[toks.findIndex((t) => t[i] === v && rest(t) === r)]) }));
    }
  }
  return [{ token: "", stems }];
}

/** The layer's own word in its file names ("09-chau1-dau" → "dau"). */
const ownToken = (key: string) => key.split("-").pop() ?? "";

/** Read a Teeinblue hand-off; null when the folder is not one. */
export function readTeeinblue(name: string, files: CtCharImportFile[], texts: CtImportTexts): CtImportRead | null {
  const cases = files.filter((f) => base(f.path).toLowerCase() === "teeinblue.json").map((f) => dir(f.path));
  if (!cases.length) return null;
  const notes = readNotes(texts);
  const problems: string[] = [];
  const byPath = new Map(files.map((f) => [f.path, f]));
  const inDir = (d: string) => files.filter((f) => dir(f.path) === d && isImage(f.path)).sort((a, b) => natural(base(a.path), base(b.path)));

  type Case = { key: string; json: Obj; dir: string };
  const read: Case[] = [];
  for (const d of cases.sort(natural)) {
    const body = texts.get(`${d ? `${d}/` : ""}teeinblue.json`);
    try {
      read.push({ key: base(d) || name, json: rec(JSON.parse(body ?? "")), dir: d });
    } catch {
      problems.push(`${d}/teeinblue.json: không đọc được JSON`);
    }
  }
  if (!read.length) return null;
  const canvas = { width: num(arr(read[0].json.kho)[0]) || 1000, height: num(arr(read[0].json.kho)[1]) || 1000 };
  const dpi = num(read[0].json.dpi) || 300;

  const variantOf = (c: Case) => {
    const k = c.key;
    const i = k.indexOf("-");
    return i > 0 ? { version: k.slice(0, i), variant: k.slice(i + 1) } : { version: k, variant: "" };
  };
  const twoLevels = new Set(read.map((c) => variantOf(c).variant)).size > 1;

  const caseVariant = (c: Case): CtCharImportVariant => {
    const order = arr(c.json.thu_tu_duoi_len_tren).map(rec);
    const links = rec(c.json.phu_thuoc);
    const defaults = notes.defaults.get(c.key) ?? new Map<string, string>();
    const layers: CtCharImportLayer[] = [];
    const stemsOf = new Map<string, CtCharImportFile[]>();
    for (const l of order) {
      const key = txt(l.lop, 120);
      if (!key) continue;
      const kind = txt(l.loai, 20);
      if (kind === "tinh") {
        const f = byPath.get(`${c.dir}/print/${key}.png`);
        if (!f) {
          problems.push(`${c.key}: thiếu file print/${key}.png`);
          continue;
        }
        layers.push({ key, label: layerLabel(key), kind: "static", follows: "", groupLabel: "", groups: [{ name: "", swatch: "", options: [{ name: layerLabel(key), url: f.url, default: true }] }] });
        continue;
      }
      const opts = inDir(`${c.dir}/print/${key}`);
      if (!opts.length) {
        problems.push(`${c.key}: lớp ${key} không có file trong print/${key}/`);
        continue;
      }
      const want = num(l.so);
      if (want && want !== opts.length) problems.push(`${c.key}: lớp ${key} ghi ${want} lựa chọn, có ${opts.length} file`);
      stemsOf.set(key, opts);
      layers.push({ key, label: layerLabel(key), kind: "choice", follows: "", groupLabel: "", groups: [] });
    }

    // Which layer follows which: the notes say ("chau<N>-dau": "cùng lựa chọn … với chau<N>-than"; "ba-toc": "chọn theo
    // ba-mu (đuôi --<mũ>)"), else two layers whose options are the same names.
    const keyLike = (pattern: string, key: string) => new RegExp(`(?:^|-)${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/<N>/g, "(\\d+)")}$`).exec(key);
    const pairs: Array<{ follower: string; leader: string; how: "same" | "suffix" }> = [];
    for (const [pattern, ruleRaw] of Object.entries(links)) {
      const rule = txt(ruleRaw, 300);
      for (const l of layers) {
        const m = keyLike(pattern, l.key);
        if (!m) continue;
        const n = m[1] ?? "";
        const target = /(?:với|theo)\s+([\w<>-]+)/i.exec(rule)?.[1]?.replace(/<N>/g, n) ?? "";
        const leader = target ? layers.find((x) => x.key !== l.key && x.key.endsWith(target)) : undefined;
        if (!leader) continue;
        pairs.push({ follower: l.key, leader: leader.key, how: /đuôi|suffix|--/i.test(rule) ? "suffix" : "same" });
      }
    }

    // Groups of each choice layer.
    const fileOf = (key: string, s: string) => stemsOf.get(key)?.find((f) => stem(f.path) === s);
    const def = (key: string) => defaults.get(key) ?? "";
    const groupsFrom = (key: string, gs: Array<{ token: string; stems: string[] }>): CtCharImportGroup[] => {
      const names = optionNames(gs[0].stems);
      return gs.map((g) => ({
        name: g.token ? tokenName(g.token) : "",
        swatch: notes.swatches.get(g.token.toLowerCase()) ?? "",
        options: g.stems.map((s, i) => ({ name: names[i] ?? s, url: fileOf(key, s)?.url ?? "", default: s === def(key) })),
      }));
    };

    // A pair "the hair follows the hat by its suffix": the hair layer leads (the customer picks colour = group,
    // hat = option); the hat layer follows, its hats repeated in every colour group.
    const handled = new Set<string>();
    for (const p of pairs.filter((x) => x.how === "suffix")) {
      const hair = stemsOf.get(p.follower) ?? [];
      const hats = stemsOf.get(p.leader) ?? [];
      const split = hair.map((f) => stem(f.path).split("--"));
      if (split.some((x) => x.length !== 2)) continue;
      const colours = [...new Set(split.map((x) => x[0]))];
      const hatNames = hats.map((f) => stem(f.path));
      const suffixOf = (hat: string) => [...new Set(split.map((x) => x[1]))].find((sfx) => hat.endsWith(`-${sfx}`) || hat === sfx);
      const order = hatNames.map((h) => ({ hat: h, sfx: suffixOf(h) })).filter((x): x is { hat: string; sfx: string } => !!x.sfx);
      if (order.length !== hats.length) continue;
      const lead = layers.find((x) => x.key === p.follower)!;
      const follow = layers.find((x) => x.key === p.leader)!;
      const colourNames = optionNames(colours);
      const hatLabels = optionNames(order.map((x) => x.hat));
      const defHat = def(p.leader);
      const defHair = def(p.follower).split("--")[0];
      lead.groupLabel = `${lead.label.split(" — ")[0]} — Hair colour`;
      lead.label = `${lead.label.split(" — ")[0]} — Hat`;
      lead.groups = colours.map((c, ci) => ({
        name: colourNames[ci],
        swatch: "",
        options: order.map((o, oi) => ({ name: hatLabels[oi], url: fileOf(p.follower, `${c}--${o.sfx}`)?.url ?? "", default: c === defHair && o.hat === defHat })),
      }));
      follow.kind = "linked";
      follow.follows = lead.key;
      follow.groups = colours.map((_, ci) => ({ name: colourNames[ci], swatch: "", options: order.map((o, oi) => ({ name: hatLabels[oi], url: fileOf(p.leader, o.hat)?.url ?? "", default: false })) }));
      handled.add(lead.key).add(follow.key);
      if (lead.groups.some((g) => g.options.some((o) => !o.url))) problems.push(`${c.key}: ${p.follower} thiếu file cho vài cặp tóc × mũ`);
    }

    // Every other choice layer: its own groups; a "same" follower mirrors its leader's groups by name.
    for (const l of layers) {
      if (l.kind !== "choice" || handled.has(l.key)) continue;
      const pair = pairs.find((x) => x.follower === l.key && x.how === "same");
      if (pair) continue;
      const stems = (stemsOf.get(l.key) ?? []).map((f) => stem(f.path));
      const gs = grouped(stems, ownToken(l.key));
      l.groups = groupsFrom(l.key, gs);
      if (gs.length > 1) l.groupLabel = `${l.label.split(" — ")[0]} — ${gs[0].token.replace(/\d+$/, "") ? cap(WORDS[gs[0].token.replace(/\d+$/, "")] ?? gs[0].token.replace(/\d+$/, "")) : "Style"}`;
    }
    for (const p of pairs.filter((x) => x.how === "same")) {
      const l = layers.find((x) => x.key === p.follower)!;
      const lead = layers.find((x) => x.key === p.leader);
      if (!lead || handled.has(l.key)) continue;
      // The follower's file for a leader option: the same name with the layer's own word swapped.
      const mine = stemsOf.get(l.key) ?? [];
      const swap = (s: string) => s.split("-").filter((t) => t !== ownToken(lead.key)).join("-");
      const index = new Map(mine.map((f) => [stem(f.path).split("-").filter((t) => t !== ownToken(l.key)).join("-"), f]));
      const leadStems = (stemsOf.get(lead.key) ?? []).map((f) => stem(f.path));
      l.kind = "linked";
      l.follows = lead.key;
      l.groups = lead.groups.map((g) => ({
        name: g.name,
        swatch: "",
        options: g.options.map((o) => {
          const s = leadStems.find((x) => fileOf(lead.key, x)?.url === o.url) ?? "";
          const f = index.get(swap(s));
          if (!f) problems.push(`${c.key}: ${l.key} không có file khớp ${s}`);
          return { name: o.name, url: f?.url ?? "", default: false };
        }),
      }));
    }
    // A lone choice layer the notes call "a choice" but with one file is static.
    for (const l of layers) if (l.kind === "choice" && l.groups.length === 1 && l.groups[0].options.length === 1) l.kind = "static";

    const above = txt(c.json.chu_nam_tren_lop, 120);
    const texts: CtCharImportText[] = arr(c.json.chu_tren_tat).map((raw, i) => {
      const t = rec(raw);
      const f = fontOf(txt(t.font, 120) || "Poppins");
      const centre = arr(t.tam);
      return {
        key: txt(t.o, 60) || `ten-${i + 1}`,
        label: `Name ${i + 1}`,
        sample: txt(t.mau_ten, 60),
        maxChars: notes.maxChars || 12,
        font: f.family,
        weight: f.weight,
        size: num(t.cao_chu),
        cx: num(centre[0]),
        cy: num(centre[1]),
        width: num(t.rong),
        angle: num(t.goc),
        color: /^#[0-9a-f]{6}$/i.test(txt(t.mau)) ? txt(t.mau).toLowerCase() : "#000000",
        above,
      };
    });
    const v = variantOf(c);
    const caseName = notes.caseNames.get(c.key) ?? "";
    return { name: twoLevels ? caseName.split(",").slice(1).join(",").trim() || v.variant : caseName || c.key, layers, texts };
  };

  // Versions (the first part of the case name, "c2") and their variants ("be").
  const versions: CtCharImportVersion[] = [];
  for (const c of read) {
    const v = variantOf(c);
    const vName = twoLevels ? v.version : c.key;
    let ver = versions.find((x) => x.name === vName);
    if (!ver) versions.push((ver = { name: vName, variants: [] }));
    ver.variants.push(caseVariant(c));
  }
  versions.sort((a, b) => natural(a.name, b.name));
  // Every version's variants in one order (the first version's).
  const vOrder = versions[0]?.variants.map((x) => x.name) ?? [];
  for (const v of versions) v.variants.sort((a, b) => vOrder.indexOf(a.name) - vOrder.indexOf(b.name));

  // Names for the customer from the sales text ("Choose the number of grandkids: 1 to 6." / "Choose the layout: A, B,
  // or C."); else the cases' own.
  const sales = salesText(texts);
  const line = (re: RegExp) => sales.description.split(/\r?\n/).map((x) => x.replace(/\*+/g, "").replace(/^[-•\s]+/, "").trim()).find((x) => re.test(x)) ?? "";
  const countLine = line(/number of/i);
  const countWhat = /number of ([a-z ]+?)[:.]/i.exec(countLine)?.[1]?.trim() ?? "";
  const versionLabel = countWhat ? `Number of ${countWhat}` : "Version";
  for (const v of versions) {
    const n = /\d+/.exec(v.name)?.[0];
    const caseName = notes.caseNames.get(`${v.name}-${read.map(variantOf).find((x) => x.version === v.name)?.variant ?? ""}`) ?? "";
    v.name = n && countWhat ? `${n} ${(Number(n) === 1 ? countWhat.replace(/s$/, "") : countWhat).replace(/\b\w/g, (ch) => ch.toUpperCase())}` : (caseName.split(",")[0]?.trim() || v.name);
  }
  const layoutLine = line(/choose the (layout|style|pose)/i);
  const layoutNames = layoutLine.includes(":")
    ? layoutLine
        .slice(layoutLine.indexOf(":") + 1)
        .replace(/\.$/, "")
        .split(/,\s*(?:or\s+)?|\s+or\s+/)
        .map((x) => cap(x.trim()))
        .filter(Boolean)
    : [];
  if (twoLevels && layoutNames.length === vOrder.length) for (const v of versions) for (const x of v.variants) x.name = layoutNames[vOrder.indexOf(x.name)] ?? x.name;
  const variantLabel = twoLevels ? (/choose the (\w+)/i.exec(layoutLine)?.[1] ? cap(/choose the (\w+)/i.exec(layoutLine)![1]) : "Layout") : "";

  // The piece: a clear acrylic cut to the design (the notes / the description say).
  const all = [...texts.values()].join("\n");
  const acrylic = /acrylic|mica/i.test(all);
  const clear = /\b(trong|clear)\b/i.test(all);
  const material = acrylic ? (clear ? "acrylic_clear" : "acrylic_white") : "";
  const cut: "alpha" | "rect" = /custom-cut|cắt theo dáng|die-cut/i.test(all) ? "alpha" : "rect";

  const roots = files.filter((f) => !f.path.slice(f.path.indexOf("/") + 1).includes("/"));
  const sample = roots.find((f) => /^(mau-goc|sample|master)\.(png|jpe?g|webp)$/i.test(base(f.path))) ?? files.find((f) => /preview/i.test(f.path) && isImage(f.path));
  const mockups = roots.filter((f) => /^mock/i.test(base(f.path)) && isImage(f.path)).sort((a, b) => natural(a.path, b.path));

  const manifest: CtCharImportManifest = {
    name,
    canvas,
    dpi,
    widthMm: Math.round((canvas.width / dpi) * 25.4 * 10) / 10,
    material: CT_MATERIALS.some((m) => m.id === material) ? material : "",
    cut,
    title: sales.title,
    description: sales.description,
    versionLabel,
    variantLabel,
    versions,
    sampleUrl: sample?.url ?? "",
    mockupUrls: mockups.map((f) => f.url).slice(0, 12),
  };
  const layersOf = (x: CtCharImportVariant) => x.layers.length;
  const optionsOf = (x: CtCharImportVariant) => x.layers.reduce((n, l) => n + l.groups.reduce((k, g) => k + g.options.length, 0), 0);
  const variants = versions.flatMap((v) => v.variants);
  const summary = [
    `Định dạng Teeinblue: ${read.length} trường hợp, khung ${canvas.width}×${canvas.height} px, ${dpi} dpi`,
    twoLevels ? `${versions.length} phiên bản (${versionLabel}: ${versions.map((v) => v.name).join(", ")}) × ${vOrder.length} kiểu (${variantLabel}: ${versions[0].variants.map((x) => x.name).join(", ")})` : `${versions.length} phiên bản: ${versions.map((v) => v.name).join(", ")}`,
    `${variants.reduce((n, x) => n + layersOf(x), 0)} lớp, ${variants.reduce((n, x) => n + optionsOf(x), 0)} file, ${variants.reduce((n, x) => n + x.texts.length, 0)} ô tên`,
    `Lớp liên kết: ${[...new Set(variants.flatMap((x) => x.layers.filter((l) => l.kind === "linked").map((l) => `${l.key.replace(/^\d+-/, "")} theo ${l.follows.replace(/^\d+-/, "")}`)))].slice(0, 8).join(", ") || "không"}`,
    `Vật liệu: ${material || "không rõ"}${cut === "alpha" ? ", cắt theo dáng" : ""} · ${mockups.length} ảnh mockup · ảnh mẫu: ${sample ? base(sample.path) : "không có"}`,
  ];
  return { manifest, summary, problems: [...new Set(problems)] };
}

/** A manifest @flexiprint wrote (MCP char_import_build) → checked, with the files it names resolved against the upload. */
export function parseManifest(raw: unknown, files: CtCharImportFile[]): { manifest: CtCharImportManifest; problems: string[] } {
  const o = rec(raw);
  const problems: string[] = [];
  const byPath = new Map(files.map((f) => [f.path, f.url]));
  const known = new Set(files.map((f) => f.url));
  // A file is named by its path in the folder (or its url).
  const url = (v: unknown, where: string): string => {
    const t = txt(v, 1000);
    const u = byPath.get(t) ?? (known.has(t) ? t : "");
    if (t && !u) problems.push(`${where}: không có file "${t}" trong folder`);
    return u;
  };
  const c = rec(o.canvas);
  const versions: CtCharImportVersion[] = arr(o.versions).map((rv, vi) => {
    const v = rec(rv);
    return {
      name: txt(v.name, 120) || `${vi + 1}`,
      variants: arr(v.variants).map((rx, xi) => {
        const x = rec(rx);
        return {
          name: txt(x.name, 120) || `${xi + 1}`,
          layers: arr(x.layers).map((rl, li) => {
            const l = rec(rl);
            const kind = l.kind === "choice" || l.kind === "linked" ? l.kind : "static";
            const key = txt(l.key, 120) || `layer-${li + 1}`;
            return {
              key,
              label: txt(l.label, 120) || layerLabel(key),
              kind,
              follows: kind === "linked" ? txt(l.follows, 120) : "",
              groupLabel: txt(l.groupLabel, 120),
              groups: arr(l.groups).map((rg) => {
                const g = rec(rg);
                return {
                  name: txt(g.name, 120),
                  swatch: /^#[0-9a-f]{6}$/i.test(txt(g.swatch)) ? txt(g.swatch).toLowerCase() : "",
                  options: arr(g.options).map((ro) => {
                    const op = rec(ro);
                    return { name: txt(op.name, 120), url: url(op.file ?? op.url, `${key}`), default: op.default === true };
                  }),
                };
              }),
            };
          }),
          texts: arr(x.texts).map((rt, ti) => {
            const t = rec(rt);
            const f = fontOf(txt(t.font, 120) || "Poppins");
            return {
              key: txt(t.key, 60) || `text-${ti + 1}`,
              label: txt(t.label, 120) || `Name ${ti + 1}`,
              sample: txt(t.sample, 120),
              maxChars: Math.max(1, Math.round(num(t.maxChars)) || 12),
              font: f.family,
              weight: Math.round(num(t.weight)) || f.weight,
              size: num(t.size),
              cx: num(t.cx),
              cy: num(t.cy),
              width: num(t.width),
              angle: num(t.angle),
              color: /^#[0-9a-f]{6}$/i.test(txt(t.color)) ? txt(t.color).toLowerCase() : "#000000",
              above: txt(t.above, 120),
            };
          }),
        };
      }),
    };
  });
  const material = txt(o.material, 40);
  const manifest: CtCharImportManifest = {
    name: txt(o.name, 200),
    canvas: { width: Math.round(num(c.width)), height: Math.round(num(c.height)) },
    dpi: num(o.dpi) || 300,
    widthMm: num(o.widthMm),
    material: CT_MATERIALS.some((m) => m.id === material) ? material : "",
    cut: o.cut === "alpha" ? "alpha" : "rect",
    title: txt(o.title, 300),
    description: txt(o.description, 8000),
    versionLabel: txt(o.versionLabel, 120) || "Version",
    variantLabel: txt(o.variantLabel, 120),
    versions,
    sampleUrl: url(o.sample ?? o.sampleUrl, "sample"),
    mockupUrls: arr(o.mockups ?? o.mockupUrls).map((m, i) => url(m, `mockup ${i + 1}`)).filter(Boolean).slice(0, 12),
  };
  if (!manifest.canvas.width || !manifest.canvas.height) problems.unshift("canvas {width, height} (px) là bắt buộc");
  if (!versions.length || versions.some((v) => !v.variants.length)) problems.unshift("versions[].variants[] trống");
  for (const v of versions)
    for (const x of v.variants)
      for (const l of x.layers) {
        if (!l.groups.length || l.groups.some((g) => !g.options.length)) problems.push(`${v.name}/${x.name}: lớp ${l.key} không có file`);
        if (l.kind === "linked") {
          const lead = x.layers.find((y) => y.key === l.follows);
          if (!lead) problems.push(`${v.name}/${x.name}: ${l.key} follows "${l.follows}" — không có lớp đó`);
          else if (lead.groups.length !== l.groups.length || lead.groups.some((g, i) => g.options.length !== l.groups[i].options.length))
            problems.push(`${v.name}/${x.name}: ${l.key} phải có nhóm / lựa chọn giống hệt ${lead.key} (cùng số, cùng thứ tự)`);
        }
      }
  if (!manifest.widthMm && manifest.canvas.width) manifest.widthMm = Math.round((manifest.canvas.width / manifest.dpi) * 25.4 * 10) / 10;
  return { manifest, problems };
}

/** Every layer file of a manifest (url) — what the build fetches, checks and stores. */
export function manifestFiles(m: CtCharImportManifest): string[] {
  return [...new Set(m.versions.flatMap((v) => v.variants.flatMap((x) => x.layers.flatMap((l) => l.groups.flatMap((g) => g.options.map((o) => o.url))))).filter(Boolean))];
}
