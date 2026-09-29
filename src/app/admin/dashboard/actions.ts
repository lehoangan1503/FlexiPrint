"use server";

import { revalidatePath } from "next/cache";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { createClient, createAdminServiceClient } from "@/lib/supabase/server";
import { isAssignableUserRole } from "@/types/auth";
import type { UserRole } from "@/types/auth";

async function assertAdmin(): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || user.app_metadata?.role !== "admin") {
    return { ok: false, error: "Không có quyền truy cập." };
  }
  return { ok: true };
}

export async function createUser(formData: FormData) {
  const guard = await assertAdmin();
  if (!guard.ok) return { error: guard.error };

  const email = formData.get("email") as string;
  const password = formData.get("password") as string;

  if (!email || !password) {
    return { error: "Email và mật khẩu là bắt buộc." };
  }

  const adminClient = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { error: createError } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (createError) {
    return { error: createError.message };
  }

  // user_profiles is automatically populated by the on_auth_user_created trigger
  revalidatePath("/admin/dashboard");
  return { success: true };
}

/**
 * Set the assignable role on a user_profiles row. Superadmin-only.
 * Never touches auth.users.app_metadata — the superadmin tier is granted
 * only via SQL (see supabase/README.md).
 */
export async function setUserRole(userId: string, role: UserRole) {
  const guard = await assertAdmin();
  if (!guard.ok) return { error: guard.error };

  if (!userId) {
    return { error: "userId là bắt buộc." };
  }

  if (!isAssignableUserRole(role)) {
    return { error: "Vai trò không hợp lệ." };
  }

  const supabase = createAdminServiceClient();
  const { data, error } = await supabase
    .from("user_profiles")
    .update({ role })
    .eq("user_id", userId)
    .select("user_id, role");

  if (error) {
    console.error("[setUserRole] update failed:", error.message, error);
    return { error: error.message };
  }

  if (!data || data.length === 0) {
    console.error("[setUserRole] no row matched user_id:", userId);
    return { error: "Không tìm thấy tài khoản để cập nhật." };
  }

  console.log("[setUserRole] updated:", data);
  revalidatePath("/admin/dashboard/accounts");
  return { success: true };
}
