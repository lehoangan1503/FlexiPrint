/* eslint-disable @next/next/no-img-element -- static screenshots from /public/news */
/**
 * /news (list: title + date, newest first) and /news/<slug> (one article). Server components — the articles are data
 * in customize-tool/news/.
 */

import Link from "next/link";
import { ArrowLeft, Info, Newspaper, TriangleAlert } from "lucide-react";
import type { CtNewsArticle, CtNewsBlock } from "../../news/types";

const dateText = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
};

/** **bold** and [text](url) inside a line. */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g).filter(Boolean);
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith("**") && p.endsWith("**")) return <strong key={i}>{p.slice(2, -2)}</strong>;
        const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(p);
        if (link)
          return (
            <a key={i} href={link[2]} className="text-sky-600 underline-offset-2 hover:underline">
              {link[1]}
            </a>
          );
        return <span key={i}>{p}</span>;
      })}
    </>
  );
}

function Block({ b }: { b: CtNewsBlock }) {
  switch (b.kind) {
    case "h":
      return <h2 className="pt-6 text-xl font-bold tracking-tight">{b.text}</h2>;
    case "p":
      return (
        <p className="leading-relaxed">
          <Inline text={b.text} />
        </p>
      );
    case "list": {
      const items = b.items.map((t, i) => (
        <li key={i} className="leading-relaxed">
          <Inline text={t} />
        </li>
      ));
      return b.ordered ? <ol className="list-decimal space-y-1.5 pl-6">{items}</ol> : <ul className="list-disc space-y-1.5 pl-6">{items}</ul>;
    }
    case "img":
      return (
        <figure className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <a href={b.src} target="_blank" rel="noreferrer" title="Mở ảnh lớn">
            <img src={b.src} alt={b.caption} className="w-full" loading="lazy" />
          </a>
          <figcaption className="border-t px-3 py-2 text-xs text-muted-foreground">{b.caption}</figcaption>
        </figure>
      );
    case "note": {
      const warn = b.tone === "warn";
      const Icon = warn ? TriangleAlert : Info;
      return (
        <div className={`flex gap-2.5 rounded-xl border p-3 text-sm leading-relaxed ${warn ? "border-amber-500/40 bg-amber-500/10" : "border-sky-500/40 bg-sky-500/10"}`}>
          <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${warn ? "text-amber-600" : "text-sky-600"}`} />
          <div>
            <Inline text={b.text} />
          </div>
        </div>
      );
    }
    case "table":
      return (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                {b.head.map((h, i) => (
                  <th key={i} className="px-3 py-2 text-left font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i} className="border-t align-top">
                  {r.map((c, j) => (
                    <td key={j} className="px-3 py-2 leading-relaxed">
                      <Inline text={c} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

function Shell({ back, title, children }: { back: string; title: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b bg-card/80 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-3xl items-center gap-3 px-4">
          <Link href={back} className="rounded p-1.5 hover:bg-accent">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <Newspaper className="h-4 w-4 text-muted-foreground" />
          <span className="truncate text-lg font-semibold">{title}</span>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-8">{children}</main>
    </div>
  );
}

export function NewsList({ articles }: { articles: CtNewsArticle[] }) {
  return (
    <Shell back="/dashboard" title="Bài viết · Hướng dẫn">
      {articles.length === 0 ? (
        <p className="text-muted-foreground">Chưa có bài nào.</p>
      ) : (
        <ul className="divide-y rounded-xl border">
          {articles.map((a) => (
            <li key={a.slug}>
              <Link href={`/news/${a.slug}`} className="block px-4 py-3 hover:bg-accent">
                <div className="flex items-baseline gap-3">
                  <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{dateText(a.createdAt)}</span>
                  <span className="font-semibold">{a.title}</span>
                </div>
                <p className="mt-0.5 line-clamp-2 pl-[5.25rem] text-sm text-muted-foreground">{a.summary}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

export function NewsArticleView({ article }: { article: CtNewsArticle }) {
  return (
    <Shell back="/news" title="Bài viết">
      <article className="space-y-4">
        <div className="text-xs text-muted-foreground">{dateText(article.createdAt)}</div>
        <h1 className="text-3xl font-bold tracking-tight">{article.title}</h1>
        <p className="text-muted-foreground">{article.summary}</p>
        {article.blocks.map((b, i) => (
          <Block key={i} b={b} />
        ))}
      </article>
    </Shell>
  );
}
