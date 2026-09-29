import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { UserProfile } from "@/types/auth";
import { DashboardClient } from "./dashboard-client";

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: existing } = await supabase.from("user_profiles").select("*").eq("user_id", user.id).maybeSingle();
  let profile = existing as UserProfile | null;
  if (!profile) {
    const { data: created } = await supabase
      .from("user_profiles")
      .upsert({ user_id: user.id, email: user.email! }, { onConflict: "user_id" })
      .select()
      .single();
    profile = (created as UserProfile | null) ?? {
      id: "",
      user_id: user.id,
      nickname: null,
      email: user.email ?? "",
      role: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  return <DashboardClient profile={profile} isSuperAdmin={user.app_metadata?.role === "admin"} />;
}
