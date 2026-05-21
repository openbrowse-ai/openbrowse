import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

const config = {
  reactStrictMode: true,
  transpilePackages: ["@openbrowse/connectors"],
  async redirects() {
    return [
      {
        source: "/docs",
        destination: "/docs/overview",
        permanent: false,
      },
    ];
  },
};

export default withMDX(config);
