// Quick check of the mockup prompt blocks helpers (lib/mockup-prompt.ts): npx tsx customize-tool/scripts/check-mockup-blocks.ts
import { badBlockRefs, mockupBlockList, mockupBlocksOf } from "../lib/mockup-prompt";

const u = (n: number) => Array.from({ length: n }, (_, i) => `https://x.test/${i}.jpg`);
const ok = (name: string, cond: boolean) => {
  console.log(cond ? "OK  " : "FAIL", name);
  if (!cond) process.exitCode = 1;
};
const old = mockupBlocksOf({ mockupScenes: "a\n---\nb", mockupRefs: u(2) });
ok("old text → 2 blocks, each with old refs", old.length === 2 && old[1].prompt === "b" && old[1].refs.length === 2);
ok("blocks win over old text", mockupBlocksOf({ mockupBlocks: [{ prompt: "z", refs: u(10) }], mockupScenes: "a" })[0].refs.length === 10);
ok("strings accepted, empty dropped", mockupBlockList(["a", " ", { prompt: "b", refs: [] }]).length === 2);
ok("16 refs fine", badBlockRefs([{ prompt: "a", refs: u(16) }]) === null);
ok("17 refs refused", badBlockRefs([{ prompt: "a", refs: u(17) }]) !== null);
ok("http refused", badBlockRefs([{ prompt: "a", refs: ["http://x/1.jpg"] }]) !== null);
ok("no blocks stored → []", mockupBlocksOf({}).length === 0);
