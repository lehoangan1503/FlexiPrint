"use client";

/**
 * Publish: snapshot the saved design into an immutable, versioned template
 * (ct_templates) that the Shopify section `main-product.liquid` renders.
 *
 * The Shopify product only needs ONE metafield pointing at this product:
 *   customize_tool.product_id = <id>
 * The section always loads the latest published version, so every later
 * Publish shows on the storefront without touching Shopify again.
 */

import { useState } from "react";
import { Check, Copy, ExternalLink, Loader2, Rocket } from "lucide-react";
import { CT_CONFIG } from "../../config";
import type { CtProduct, CtPublishResponse } from "../../types";
import { ctApi } from "../../lib/api-client";
import { CtButton, CtModal } from "../ui";

export function PublishDialog({
  open,
  onOpenChange,
  product,
  dirty,
  onSave,
  onPublished,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  product: CtProduct;
  dirty: boolean;
  onSave: () => Promise<boolean>;
  onPublished: (p: CtProduct) => void;
}) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CtPublishResponse | null>(null);

  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const templateUrl = result?.templateUrl ?? `${origin}${CT_CONFIG.apiBase}/public/templates/${product.id}`;

  const publish = async () => {
    setRunning(true);
    setError(null);
    try {
      // Publishing snapshots what is in the DB, so unsaved edits go first.
      if (dirty && !(await onSave())) throw new Error("Lưu thiết kế thất bại — chưa publish.");
      const r = await ctApi.publish(product.id);
      setResult(r.publish);
      onPublished(r.product);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Publish thất bại");
    } finally {
      setRunning(false);
    }
  };

  return (
    <CtModal open={open} onOpenChange={(o) => !running && onOpenChange(o)} title="Publish lên Shopify">
      <div className="space-y-4 text-sm">
        <p className="text-muted-foreground">
          Publish tạo một bản snapshot có version của thiết kế đã lưu. Section <code>main-product.liquid</code> luôn tải bản mới nhất,
          nên sau lần gắn metafield đầu tiên, mỗi lần Publish sẽ hiện ngay trên store.
        </p>

        <div className="flex items-center justify-between rounded-md border p-3">
          <div>
            <div className="font-medium">{product.published_version ? `Đang live: v${product.published_version}` : "Chưa publish lần nào"}</div>
            {product.published_at && <div className="text-xs text-muted-foreground">{new Date(product.published_at).toLocaleString()}</div>}
            {dirty && <div className="text-xs text-amber-500">Có thay đổi chưa lưu — sẽ được lưu trước khi publish.</div>}
          </div>
          <CtButton variant="primary" onClick={publish} disabled={running}>
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
            Publish v{(product.published_version ?? 0) + 1}
          </CtButton>
        </div>
        {error && <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">{error}</div>}
        {result && (
          <div className="flex items-center gap-2 rounded-md border border-emerald-500/50 bg-emerald-500/10 p-2 text-xs text-emerald-600">
            <Check className="h-3.5 w-3.5" /> Đã publish v{result.version}
          </div>
        )}

        <div className="space-y-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Gắn vào sản phẩm Shopify (1 lần)</div>
          <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
            <li>
              Tạo product metafield <code>customize_tool.product_id</code> (Single line text) rồi dán giá trị bên dưới.
            </li>
            <li>
              Section <code>main-product.liquid</code> + asset <code>ct-customizer.js</code>/<code>.css</code> nằm trong{" "}
              <code>customize-tool/shopify/</code>. Trong section settings, đặt <b>API base</b> = <code>{origin}</code>.
            </li>
          </ol>
          <CopyRow label="Metafield customize_tool.product_id" value={product.id} />
          <CopyRow label="Template JSON (public)" value={templateUrl} link={Boolean(product.published_version || result)} />
        </div>
      </div>
    </CtModal>
  );
}

function CopyRow({ label, value, link }: { label: string; value: string; link?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="flex items-center gap-1.5">
        <code className="min-w-0 flex-1 truncate rounded border bg-muted/40 px-2 py-1.5 text-xs">{value}</code>
        <CtButton
          size="icon"
          variant="ghost"
          aria-label="Copy"
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
        </CtButton>
        {link && (
          <a href={value} target="_blank" rel="noreferrer" className="rounded p-2 hover:bg-accent" aria-label="Mở">
            <ExternalLink className="h-4 w-4" />
          </a>
        )}
      </div>
    </div>
  );
}
