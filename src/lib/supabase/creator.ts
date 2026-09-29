import { createAdminServiceClient } from "@/lib/supabase/server";

interface ProfileName {
  user_id: string;
  nickname: string | null;
  email: string | null;
}

/**
 * Batch-resolve display names for a list of user IDs (server only, service role).
 * Returns userId → nickname, else email, else "Unknown".
 */
export async function resolveCreatorNames(userIds: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(userIds.filter(Boolean))];
  if (unique.length === 0) return {};

  const { data } = await createAdminServiceClient().from("user_profiles").select("user_id, nickname, email").in("user_id", unique);

  const map: Record<string, string> = {};
  for (const p of (data as ProfileName[] | null) ?? []) {
    map[p.user_id] = p.nickname?.trim() || p.email || "Unknown";
  }
  return map;
}
