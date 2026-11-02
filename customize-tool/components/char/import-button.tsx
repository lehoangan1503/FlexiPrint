"use client";

/**
 * "Import bộ" (asked 2026-10-29): a folder of finished files — a Teeinblue export that already sells — becomes a bộ
 * nhân vật with its product (server/char/import.ts). Since 2026-11-02 the folders are dropped / picked on their own page
 * (/v2/import, components/char/import-page.tsx), where several upload at once and keep going across the app.
 */

import Link from "next/link";
import { FolderUp } from "lucide-react";

export function ImportButton() {
  return (
    <Link
      href="/v2/import"
      title="Tải folder bộ clipart đã làm sẵn (Teeinblue…) → bộ nhân vật + sản phẩm — được nhiều bộ cùng lúc"
      className="inline-flex h-9 items-center gap-2 rounded-md border bg-background px-3.5 text-sm font-medium hover:bg-accent"
    >
      <FolderUp className="h-4 w-4" /> Import bộ clipart
    </Link>
  );
}
