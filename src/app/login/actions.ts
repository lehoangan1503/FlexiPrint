"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

async function upsertUserProfile(supabase: Awaited<ReturnType<typeof createClient>>, userId: string, email: string) {
  await supabase
    .from("user_profiles")
    .upsert({ user_id: userId, email }, { onConflict: "user_id", ignoreDuplicates: false })
    .select();
}

export async function login(formData: FormData) {
  const supabase = await createClient();

  const data = {
    email: formData.get("email") as string,
    password: formData.get("password") as string,
  };

  const { data: authData, error } = await supabase.auth.signInWithPassword(data);

  if (error) {
    return { error: error.message };
  }

  if (authData.user) {
    await upsertUserProfile(supabase, authData.user.id, authData.user.email!);
  }

  revalidatePath("/", "layout");
  redirect("/dashboard");
}

export async function logout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/login");
}
