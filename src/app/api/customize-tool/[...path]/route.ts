// Route shim — the Customize Tool API lives in /customize-tool/server/router.ts.
import { ctRouteHandlers } from "../../../../../customize-tool/server/router";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = ctRouteHandlers;
// AI image requests take 10–60s.
export const maxDuration = 120;
