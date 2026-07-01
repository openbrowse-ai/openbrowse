#!/usr/bin/env node
// Bundles src/index.ts into dist/index.js as a single ESM file.
//
// Why bundle instead of tsc-only:
//  - Source uses extensionless relative imports (`import x from "./server"`)
//    which is fine under TypeScript's `moduleResolution: "bundler"` at
//    compile time but breaks Node ESM at runtime (Node ESM requires
//    explicit `.js` extensions). Bundling resolves everything at build
//    time, so the emitted output has zero import-path surprises.
//  - Ships a single file to npm consumers; simplifies the install.
//
// External deps: keep `ws` and Node built-ins external so users get the
// real installed package rather than a mis-bundled copy of a native-ish
// module.

import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // Ship a single, tree-shaken file. Externalising built-ins is the
  // default under platform=node. Also externalise runtime deps so
  // users' `node_modules/` copies are used instead of a possibly-stale
  // bundled version.
  external: Object.keys(pkg.dependencies ?? {}),
  sourcemap: true,
  logLevel: "info",
  // Preserve error names + stack frames. `minify` collapses those.
  minify: false,
  // Some transitive TS files reference `import.meta.url`; keep it.
  banner: {
    js: [
      "// @openbrowse/mcp-server — bundled by esbuild",
      "// Do not edit; regenerate via `pnpm build`.",
    ].join("\n"),
  },
});

console.log("✓ dist/index.js written");
