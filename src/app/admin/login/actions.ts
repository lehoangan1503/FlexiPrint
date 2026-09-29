"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function adminLogin(formData: FormData) {
  const supabase = await createClient();

  const email = formData.get("email") as string;
  const password = formData.get("password") as string;

  const { data: authData, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return { error: error.message };
  }

  // Verify the user has admin role in app_metadata
  if (authData.user?.app_metadata?.role !== "admin") {
    // Sign out immediately — this user is not an admin
    await supabase.auth.signOut();
    return { error: "Bạn không có quyền truy cập trang quản trị." };
  }

  revalidatePath("/", "layout");
  redirect("/admin/dashboard");
}

export async function adminLogout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/admin/login");
}
