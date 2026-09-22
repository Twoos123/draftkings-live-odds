import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Node-only clients: load them with require() instead of bundling.
  serverExternalPackages: ["ws", "@clickhouse/client"],
};

export default nextConfig;
