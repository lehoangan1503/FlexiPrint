import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Users } from "lucide-react";
import { CreateUserForm } from "../create-user-form";
import { RoleSelect } from "../role-select";
import type { UserProfile } from "@/types/auth";

interface AccountRow extends UserProfile {
  /** Superadmin — auth.users.app_metadata.role === 'admin'. Not editable here. */
  isSuperAdmin: boolean;
}

async function getAccounts(): Promise<AccountRow[]> {
  const supabase = await createServiceClient();
  const { data: profiles, error } = await supabase
    .from("user_profiles")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[admin] Failed to fetch user_profiles:", error.message);
    return [];
  }

  // Determine which users are SUPERADMINS (auth.users.app_metadata.role).
  // This tier is granted only via SQL/service key and is not editable here.
  const adminClient = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
  const superAdminIds = new Set<string>();
  try {
    const { data: list } = await adminClient.auth.admin.listUsers({ perPage: 1000 });
    for (const u of list?.users ?? []) {
      if (u.app_metadata?.role === "admin") superAdminIds.add(u.id);
    }
  } catch (e) {
    console.error("[admin] Failed to list auth users:", e);
  }

  return ((profiles as UserProfile[]) ?? []).map((p) => ({
    ...p,
    isSuperAdmin: superAdminIds.has(p.user_id),
  }));
}

export default async function AdminAccountsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || user.app_metadata?.role !== "admin") {
    redirect("/admin/login");
  }

  const accounts = await getAccounts();

  return (
    <>
      <CreateUserForm />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Users className="h-5 w-5" />
            Danh Sách Người Dùng
            <span className="ml-auto text-sm font-normal text-muted-foreground">
              {accounts.length} tài khoản
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              Chưa có tài khoản nào.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">Email</th>
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">Nickname</th>
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">Vai trò</th>
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">Ngày tạo</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((u) => (
                    <tr key={u.user_id} className="border-b last:border-0 hover:bg-muted/50">
                      <td className="py-3 px-2">{u.email}</td>
                      <td className="py-3 px-2 text-muted-foreground">{u.nickname ?? "—"}</td>
                      <td className="py-3 px-2">
                        {u.isSuperAdmin ? (
                          <div className="flex flex-col gap-1">
                            <Badge variant="outline" className="w-fit border-amber-500/40 text-amber-500">
                              Supabase Admin
                            </Badge>
                            <span className="text-[11px] text-muted-foreground">
                              Toàn quyền — chỉ đổi được bằng SQL
                            </span>
                          </div>
                        ) : (
                          <RoleSelect userId={u.user_id} role={u.role} />
                        )}
                      </td>
                      <td className="py-3 px-2 text-muted-foreground">
                        {new Date(u.created_at).toLocaleDateString("vi-VN", {
                          day: "2-digit",
                          month: "2-digit",
                          year: "numeric",
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
