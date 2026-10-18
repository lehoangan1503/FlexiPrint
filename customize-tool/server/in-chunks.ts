/**
 * Rows whose column is one of many ids, asked in slices (found 2026-10-18: a family rug of 5 versions × 24 layers —
 * 121 region ids in one `in(...)` filter made a URL nginx refuses with 502, and the product read as having no
 * options). Every read whose id list grows with a product's layers / cliparts goes through here.
 */

const SLICE = 40;

interface Answer<T> {
  data: T[] | null;
  error: { message: string } | null;
}

/** `run` asked once per slice of `ids`, the rows joined (order: by slice — sort afterwards when it matters). */
export async function inChunks<T>(ids: string[], run: (slice: string[]) => PromiseLike<Answer<T>>): Promise<T[]> {
  const slices: string[][] = [];
  for (let i = 0; i < ids.length; i += SLICE) slices.push(ids.slice(i, i + SLICE));
  const answers = await Promise.all(slices.map((s) => run(s)));
  const failed = answers.find((a) => a.error);
  if (failed?.error) throw new Error(failed.error.message);
  return answers.flatMap((a) => a.data ?? []);
}
