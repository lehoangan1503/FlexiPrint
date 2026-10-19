/**
 * This instance's public address, for links the agent prints (the set's page, the product editor). Two instances
 * run the same code (flexiprint.next.lc on the VPS, flexi2.next.lc on an-vm): each knows its own from APP_DOMAIN —
 * NEXT_PUBLIC_SITE_URL was never set, so flexi2 printed VPS links (2026-10-19).
 */
export function siteUrl(): string {
  const set = process.env.SITE_URL ?? process.env.NEXT_PUBLIC_SITE_URL;
  if (set) return set.replace(/\/$/, "");
  return `https://${process.env.APP_DOMAIN || "flexiprint.next.lc"}`;
}
