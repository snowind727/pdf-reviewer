import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 降低 Webpack 构建峰值内存，缓解小内存 Linux 实例上的 OOM / Bus error
  experimental: {
    webpackMemoryOptimizations: true,
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.alias.canvas = false;
      config.resolve.alias.encoding = false;
    }
    return config;
  },
};

export default nextConfig;
