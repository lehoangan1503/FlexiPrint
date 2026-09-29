import Link from "next/link";
import { Package } from "lucide-react";
import { createAdminServiceClient } from "@/lib/supabase/server";
import { resolveCreatorNames } from "@/lib/supabase/creator";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface ProductRow {
  id: string;
  user_id: string;
  name: string;
  status: string;
  thumbnail_url: string | null;
  published_version: number | null;
  published_at: string | null;
  updated_at: string;
}

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";

/** Every user's products (the layout already guards superadmin). */
export default async function AdminProductsPage() {
  const supabase = createAdminServiceClient();
  const { data, error } = await supabase
    .from("ct_products")
    .select("id, user_id, name, status, thumbnail_url, published_version, published_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(500);
  const products = (data as ProductRow[] | null) ?? [];
  const owners = await resolveCreatorNames(products.map((p) => p.user_id));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Package className="h-5 w-5" />
          Sản phẩm
          <span className="ml-auto text-sm font-normal text-muted-foreground">{products.length} sản phẩm</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {error && <p className="text-sm text-destructive">{error.message}</p>}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="px-2 py-3 font-medium">Sản phẩm</th>
                <th className="px-2 py-3 font-medium">Người tạo</th>
                <th className="px-2 py-3 font-medium">Publish</th>
                <th className="px-2 py-3 font-medium">Cập nhật</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id} className="border-b last:border-0 hover:bg-muted/50">
                  <td className="px-2 py-2">
                    <Link href={`/products/${p.id}`} className="flex items-center gap-2 hover:underline">
                      {p.thumbnail_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={p.thumbnail_url} alt="" className="h-9 w-9 rounded object-cover" />
                      ) : (
                        <span className="h-9 w-9 rounded bg-muted" />
                      )}
                      {p.name}
                    </Link>
                  </td>
                  <td className="px-2 py-2 text-muted-foreground">{owners[p.user_id] ?? "—"}</td>
                  <td className="px-2 py-2">
                    {p.published_version ? (
                      <Badge variant="outline" className="border-emerald-500/40 text-emerald-500">
                        v{p.published_version} · {fmt(p.published_at)}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">Chưa publish</span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-muted-foreground">{fmt(p.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
