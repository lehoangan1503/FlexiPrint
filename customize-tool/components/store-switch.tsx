"use client";

/**
 * The /dashboard store switch (asked 2026-11-10): the Shopify store the user works on — Sản phẩm and Artwork list
 * that store's rows, new artworks / products land in it (migration 032). Product base and Thư viện are shared.
 */

import { useEffect, useState } from "react";
import { AlertTriangle, Store } from "lucide-react";
import type { CtStore } from "../types";
import { ctApi } from "../lib/api-client";
import { CtSelect } from "./ui";

export function StoreSwitch({ onChange }: { onChange: (store: CtStore) => void }) {
  const [stores, setStores] = useState<CtStore[]>([]);
  const [current, setCurrent] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    ctApi
      .listStores()
      .then((r) => {
        if (cancelled) return;
        setStores(r.stores);
        setCurrent(r.current);
        const st = r.stores.find((x) => x.id === r.current);
        if (st) onChange(st);
      })
      // The lists still show (the server falls back to the user's current store).
      .catch(() => onChange({ id: "", name: "", shopDomain: "", publicUrl: "", configured: false }));
    return () => {
      cancelled = true;
    };
    // Once: the parent only learns the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = async (id: string) => {
    if (id === current) return;
    setBusy(true);
    try {
      const r = await ctApi.setCurrentStore(id);
      setStores(r.stores);
      setCurrent(r.current);
      const st = r.stores.find((x) => x.id === r.current);
      if (st) onChange(st);
    } finally {
      setBusy(false);
    }
  };

  const shown = stores.find((x) => x.id === current);
  if (stores.length < 2 && !shown) return null;
  return (
    <div className="flex items-center gap-1.5">
      <Store className="h-4 w-4 text-muted-foreground" />
      <CtSelect<string>
        value={current}
        onChange={(v) => void pick(v)}
        disabled={busy}
        className="h-8 w-40 font-medium"
        options={stores.map((x) => ({ value: x.id, label: x.name }))}
      />
      {shown && !shown.configured && (
        <span title={`Store ${shown.name} chưa cấu hình app Shopify trên server — deploy sẽ lỗi`}>
          <AlertTriangle className="h-4 w-4 text-amber-500" />
        </span>
      )}
    </div>
  );
}

let storesOnce: Promise<CtStore[]> | null = null;

/** The store's name on an artwork / product page (only when there is more than one store). */
export function StoreTag({ storeId }: { storeId?: string }) {
  const [stores, setStores] = useState<CtStore[]>([]);
  useEffect(() => {
    let cancelled = false;
    storesOnce ??= ctApi.listStores().then((r) => r.stores).catch(() => []);
    void storesOnce.then((list) => {
      if (!cancelled) setStores(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  if (stores.length < 2) return null;
  const st = stores.find((x) => x.id === storeId) ?? stores[0];
  return (
    <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-semibold text-amber-600" title="Store của artwork / sản phẩm này (đổi store ở dashboard)">
      {st.name}
    </span>
  );
}
