"use client";

/**
 * /studio — the ComfyUI studio (services/comfy) embedded full-screen.
 *
 * ComfyUI has no login: POST studio/session first sets the fp_studio cookie
 * that nginx checks (server/studio.ts), then the iframe loads. The FlexiPrint
 * node pack inside ComfyUI reads / writes the clipart library directly.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ExternalLink, Library, Loader2 } from "lucide-react";
import { ctApi } from "../../lib/api-client";

export function StudioFrame() {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ctApi
      .studioSession()
      .then((r) => setUrl(r.url))
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b px-3 text-sm">
        <Link href="/dashboard" className="rounded p-1 hover:bg-accent">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <span className="font-semibold">Studio</span>
        <span className="text-xs text-muted-foreground">ComfyUI · node FlexiPrint: tạo clipart gốc, bộ biến thể, vật liệu, mockup → lưu thẳng vào thư viện</span>
        <Link href="/library" target="_blank" className="ml-auto inline-flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-accent">
          <Library className="h-3.5 w-3.5" /> Thư viện
        </Link>
        {url && (
          <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-accent">
            <ExternalLink className="h-3.5 w-3.5" /> Mở tab riêng
          </a>
        )}
      </header>
      {error ? (
        <div className="flex flex-1 items-center justify-center text-sm text-destructive">{error}</div>
      ) : url ? (
        <iframe src={url} title="ComfyUI Studio" className="min-h-0 w-full flex-1 border-0" allow="clipboard-read; clipboard-write" />
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      )}
    </div>
  );
}
