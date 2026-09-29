/**
 * Account roles.
 *
 *   superadmin  auth.users.app_metadata.role = 'admin' — set by SQL only; the only
 *               role that can open /admin/*.
 *   admin       user_profiles.role = 'admin' — tool admin: edits every product and
 *               the shared AI style library.
 *   mode        user_profiles.role = 'mode' — moderator.
 *   null        normal user.
 */
export type UserRole = "admin" | "mode" | null;

export const ASSIGNABLE_USER_ROLES: UserRole[] = [null, "mode", "admin"];

export function isAssignableUserRole(value: unknown): value is UserRole {
  return value === null || value === "mode" || value === "admin";
}

export interface UserProfile {
  id: string;
  user_id: string;
  nickname: string | null;
  email: string;
  role: UserRole;
  created_at: string;
  updated_at: string;
}
