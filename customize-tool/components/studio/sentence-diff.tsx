/** Sentence-level before / after of a prompt rewrite — shared by the refine panel and the category revision. */

function sentences(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]*/g) ?? []).map((x) => x.trim()).filter(Boolean);
}

const sentenceKey = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** What a spec / style rewrite drops (red) and adds (green), sentence by sentence — a dropped core sentence is visible before saving. */
export function SentenceDiff({ before, after }: { before: string; after: string }) {
  const old = sentences(before);
  const next = sentences(after);
  const oldKeys = new Set(old.map(sentenceKey));
  const nextKeys = new Set(next.map(sentenceKey));
  const dropped = old.filter((x) => !nextKeys.has(sentenceKey(x)));
  const added = next.filter((x) => !oldKeys.has(sentenceKey(x)));
  if (!dropped.length && !added.length) return <p className="text-[11px] text-muted-foreground">Không đổi so với bản đang lưu.</p>;
  return (
    <div className="space-y-1 rounded-md border bg-background/60 p-2 text-[11px] leading-snug">
      <div className="font-medium">
        So với bản đang lưu: {old.length - dropped.length}/{old.length} câu giữ nguyên
        {dropped.length > 0 && <span className="text-rose-500"> · {dropped.length} câu bị bỏ / sửa — kiểm tra kỹ</span>}
      </div>
      {dropped.map((x) => (
        <p key={`-${x}`} className="text-rose-500 line-through decoration-rose-500/60">− {x}</p>
      ))}
      {added.map((x) => (
        <p key={`+${x}`} className="text-emerald-600">+ {x}</p>
      ))}
    </div>
  );
}
