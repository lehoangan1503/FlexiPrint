/**
 * Every /news article (customize-tool/news/types.ts). A new one: add a file in articles/ and put it in this list —
 * the page sorts newest first by createdAt.
 */

import type { CtNewsArticle } from "./types";
import { phoiPreviewMockup } from "./articles/2026-11-17-phoi-preview-mockup";

const ALL: CtNewsArticle[] = [phoiPreviewMockup];

export const NEWS: CtNewsArticle[] = [...ALL].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

export const newsArticle = (slug: string): CtNewsArticle | null => NEWS.find((a) => a.slug === slug) ?? null;
