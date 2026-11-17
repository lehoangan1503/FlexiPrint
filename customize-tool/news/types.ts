/**
 * /news — the team's guides and summaries (asked 2026-11-17: "làm 1 route /news … khi nào tôi cần tóm tắt hoặc hướng
 * dẫn gì bạn chỉ cần tạo 1 bài viết, hiển thị các bài viết dạng list, có ngày tạo và tiêu đề"). One article = one file
 * in news/articles/, listed in news/index.ts. Text supports **bold** and [link](url).
 */

export type CtNewsBlock =
  | { kind: "h"; text: string }
  | { kind: "p"; text: string }
  | { kind: "list"; items: string[]; ordered?: boolean }
  /** A screenshot in public/news/… (src = path from the site root). */
  | { kind: "img"; src: string; caption: string }
  | { kind: "note"; text: string; tone?: "info" | "warn" }
  | { kind: "table"; head: string[]; rows: string[][] };

export interface CtNewsArticle {
  /** URL: /news/<slug>. */
  slug: string;
  title: string;
  /** ISO date (YYYY-MM-DD) — the list is newest first. */
  createdAt: string;
  /** One or two lines under the title in the list. */
  summary: string;
  /** The card's picture in the list (path from the site root); default = the article's first picture. */
  thumb?: string;
  blocks: CtNewsBlock[];
}
