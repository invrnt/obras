import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Cloudflare already compresses at the edge; skip double work on the mini PC.
  compress: false,
};

export default nextConfig;
