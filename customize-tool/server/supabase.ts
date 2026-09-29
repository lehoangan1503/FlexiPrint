/**
 * Server Supabase client for the Customize Tool.
 *
 * Built directly on @supabase/ssr (not the host's src/lib/supabase) so the
 * folder keeps working when moved to its own app with the same env vars.
 * Requests run as the signed-in user; RLS in migrations/001 decides access.
 */

import { createServerClient } from "@supabase/ssr";
import { createClient, type User } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { CT_CONFIG } from "../config";

export async function ctSupabase() {
  const cookieStore = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    db: { schema: CT_CONFIG.dbSchema },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component — the host middleware refreshes the session.
        }
      },
    },
  });
}

export type CtSupabase = Awaited<ReturnType<typeof ctSupabase>>;

export interface CtSession {
  supabase: CtSupabase;
  user: User;
}

export async function ctSession(): Promise<CtSession | null> {
  const supabase = await ctSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user ? { supabase, user } : null;
}

/**
 * Service-role client for the PUBLIC storefront endpoints (template read,
 * customer uploads), which have no signed-in user. Null when the key is not
 * configured — those endpoints then answer 501. Never hand it to user input
 * without an explicit filter: it bypasses RLS.
 */
export function ctServiceClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return null;
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    db: { schema: CT_CONFIG.dbSchema },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type CtServiceClient = NonNullable<ReturnType<typeof ctServiceClient>>;
