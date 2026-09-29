import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import type { UserRole } from "@/types/auth";

export interface SessionRole {
  userId: string | null;
  user: User | null;
  /**
   * Superadmin — auth.users.app_metadata.role === 'admin'. Granted only via
   * SQL/service key. The only role with access to /admin/*.
   */
  isSuperAdmin: boolean;
  /**
   * Tool admin — user_profiles.role === 'admin'. Edits the shared AI style
   * library; no /admin/* access. Superadmins implicitly have these powers too.
   */
  isToolAdmin: boolean;
  isMode: boolean;
  /** The assignable role on user_profiles, or null for a normal user. */
  profileRole: UserRole;
}

const ANONYMOUS: SessionRole = {
  userId: null,
  user: null,
  isSuperAdmin: false,
  isToolAdmin: false,
  isMode: false,
  profileRole: null,
};

/**
 * Resolve the current request's auth context and role.
 *
 * Two independent tiers:
 * - superadmin: auth.users.app_metadata.role (authoritative for /admin routing).
 * - tool admin / mode: user_profiles.role (assigned by the superadmin in the UI).
 */
export async function getSessionRole(): Promise<SessionRole> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return ANONYMOUS;

  const isSuperAdmin = user.app_metadata?.role === "admin";

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();

  const profileRole = (profile?.role ?? null) as UserRole;
  const isToolAdmin = isSuperAdmin || profileRole === "admin";
  const isMode = profileRole === "mode";

  return {
    userId: user.id,
    user,
    isSuperAdmin,
    isToolAdmin,
    isMode,
    profileRole,
  };
}
