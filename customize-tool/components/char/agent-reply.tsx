"use client";

/**
 * The agent's whole last message as agent_ide shows it (asked 2026-11-04: the chat showed only the short summary of
 * submit_result, "Chi tiết ở dưới" pointed at nothing). A small markdown subset the agent writes: paragraphs, "- " and
 * "1. " lists, "#" headings, **bold**, `code`, links, and agent_ide's folding blocks <!--more: Title--> … <!--/more-->
 * (shown open — the editor wants to read everything).
 */

import { Fragment, type ReactNode } from "react";

interface Section {
  title: string | null;
  body: string;
}

/** Splits the text at agent_ide's <!--more: Title--> … <!--/more--> blocks. */
function sections(text: string): Section[] {
  const out: Section[] = [];
  const re = /<!--\s*more:?\s*([^>]*?)\s*-->([\s\S]*?)<!--\s*\/more\s*-->/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) out.push({ title: null, body: text.slice(at, m.index) });
    out.push({ title: m[1] || "Chi tiết", body: m[2] });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ title: null, body: text.slice(at) });
  // A comment the agent left elsewhere (<!-- … -->) is not for the editor.
  return out.map((s) => ({ ...s, body: s.body.replace(/<!--[\s\S]*?-->/g, "") })).filter((s) => s.body.trim());
}

/** **bold**, `code` and links inside one line. */
function inline(line: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|(https?:\/\/[^\s)<>]+[^\s)<>.,;:!?])/g;
  let at = 0;
  let k = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m.index > at) out.push(line.slice(at, m.index));
    if (m[1] !== undefined) out.push(<strong key={k++}>{m[1]}</strong>);
    else if (m[2] !== undefined)
      out.push(
        <code key={k++} className="rounded bg-muted px-1 text-[0.9em]">
          {m[2]}
        </code>,
      );
    else
      out.push(
        <a key={k++} href={m[3]} target="_blank" rel="noreferrer" className="break-all text-violet-600 underline">
          {m[3]}
        </a>,
      );
    at = m.index + m[0].length;
  }
  if (at < line.length) out.push(line.slice(at));
  return out;
}

/** A paragraph / heading (its lines) or a list (one line per item). */
interface Block {
  kind: "p" | "h" | "ul" | "ol";
  lines: string[];
}

function blocks(body: string): Block[] {
  const out: Block[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trimEnd();
    const last = out[out.length - 1];
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (!line.trim()) out.push({ kind: "p", lines: [] });
    else if (heading) out.push({ kind: "h", lines: [heading[1]] });
    else if (bullet) {
      if (last?.kind === "ul") last.lines.push(bullet[1]);
      else out.push({ kind: "ul", lines: [bullet[1]] });
    } else if (numbered) {
      if (last?.kind === "ol") last.lines.push(numbered[1]);
      else out.push({ kind: "ol", lines: [numbered[1]] });
    } else if ((last?.kind === "ul" || last?.kind === "ol") && /^\s{2,}/.test(raw)) {
      // A wrapped list item.
      last.lines[last.lines.length - 1] += ` ${line.trim()}`;
    } else if (last?.kind === "p") last.lines.push(line);
    else out.push({ kind: "p", lines: [line] });
  }
  return out.filter((b) => b.lines.length);
}

function Body({ body }: { body: string }) {
  return (
    <div className="space-y-1.5">
      {blocks(body).map((b, i) =>
        b.kind === "ul" || b.kind === "ol" ? (
          <Fragment key={i}>
            {b.kind === "ul" ? (
              <ul className="list-disc space-y-0.5 pl-5">
                {b.lines.map((it, j) => (
                  <li key={j}>{inline(it)}</li>
                ))}
              </ul>
            ) : (
              <ol className="list-decimal space-y-0.5 pl-5">
                {b.lines.map((it, j) => (
                  <li key={j}>{inline(it)}</li>
                ))}
              </ol>
            )}
          </Fragment>
        ) : b.kind === "h" ? (
          <p key={i} className="font-semibold">
            {inline(b.lines[0])}
          </p>
        ) : (
          <p key={i}>
            {b.lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {inline(l)}
              </Fragment>
            ))}
          </p>
        ),
      )}
    </div>
  );
}

export function AgentReply({ text, proposal }: { text: string; proposal?: string }) {
  return (
    <div className="space-y-2 break-words">
      {sections(text).map((s, i) =>
        s.title ? (
          <details key={i} open className="rounded border bg-muted/30 px-2 py-1">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground">{s.title}</summary>
            <div className="pt-1">
              <Body body={s.body} />
            </div>
          </details>
        ) : (
          <Body key={i} body={s.body} />
        ),
      )}
      {!!proposal?.trim() && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5">
          <div className="mb-1 text-xs font-medium text-amber-700 dark:text-amber-400">Đề xuất cho dev</div>
          <Body body={proposal} />
        </div>
      )}
    </div>
  );
}
