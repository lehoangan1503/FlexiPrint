import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Everything except static files, R2 file proxy (/files) and the public
     * storefront API (called from Shopify, no Supabase cookie to refresh).
     */
    "/((?!files/|api/customize-tool/public|api/customize-tool/cron|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
