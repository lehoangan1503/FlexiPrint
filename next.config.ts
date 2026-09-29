import type { NextConfig } from "next";

/** Largest request body anywhere (uploads, print files) — nginx client_max_body_size matches. */
const MAX_BODY = 500 * 1024 * 1024;

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    proxyClientMaxBodySize: MAX_BODY,
    serverActions: { bodySizeLimit: "500mb" },
  },
};

export default nextConfig;
