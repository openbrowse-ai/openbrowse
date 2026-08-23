import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "wxt";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { walkSkills } from "./src/build/walk-skills";

// Files copied from the `pyodide` npm package into `pyodide/` in the
// extension output. Loaded at runtime by the offscreen Pyodide worker via
// `chrome.runtime.getURL('pyodide/...')`. The set is intentionally narrow:
// only the JS/WASM/stdlib/lockfile actually needed at runtime.
const PYODIDE_RUNTIME_FILES = [
  "pyodide.mjs",
  "pyodide.asm.js",
  "pyodide.asm.wasm",
  "python_stdlib.zip",
  "pyodide-lock.json",
] as const;

export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/module-react"],
  webExt: {
    chromiumArgs: ["--user-data-dir=.wxt/chrome-data"],
  },
  hooks: {
    "build:publicAssets": (wxt, assets) => {
      const skillsDir = path.resolve(wxt.config.root, "public/skills");
      if (fs.existsSync(skillsDir)) {
        const manifest = walkSkills(skillsDir);
        assets.push({
          relativeDest: "skills-manifest.json",
          contents: JSON.stringify(manifest, null, 2),
        });
      }

      // Bundle the Pyodide runtime from node_modules into the extension
      // output. Done as a build hook (rather than committing to public/)
      // so we never check 12MB of WASM into git, and so the version
      // tracks whatever `pyodide` resolves to in the lockfile.
      const require = createRequire(import.meta.url);
      let pyodideDir: string | null = null;
      try {
        const pkgJson = require.resolve("pyodide/package.json");
        pyodideDir = path.dirname(pkgJson);
      } catch {
        // pyodide not installed (e.g. fresh clone before pnpm install)
      }
      if (pyodideDir) {
        for (const name of PYODIDE_RUNTIME_FILES) {
          const src = path.join(pyodideDir, name);
          if (!fs.existsSync(src)) {
            console.warn(
              `[openbrowse] pyodide runtime file missing: ${name} (${src})`,
            );
            continue;
          }
          assets.push({
            relativeDest: `pyodide/${name}`,
            absoluteSrc: src,
          });
        }
      }
    },
    // WXT auto-injects `side_panel.default_path` whenever a `sidepanel`
    // entrypoint exists. We deliberately don't want that — declaring a
    // global side panel makes Chrome show it on every tab by default,
    // which fights against per-tab scoping (the global panel leaks
    // onto other tabs in the window). Stripping this leaves Chrome
    // with no default panel; we register per-tab via setOptions when
    // the user explicitly opens it, giving us native per-tab isolation.
    "build:manifestGenerated": (_wxt, manifest) => {
      delete (manifest as { side_panel?: unknown }).side_panel;
    },
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: ({ mode }) => ({
    name: "OpenBrowse",
    description: "The open source browser agent.",
    // Pins the extension ID to the Chrome Web Store listing. Required so
    // that storage from manual / unpacked installs (loaded from a release
    // zip) carries over to the Web Store install: same `key` -> same
    // extension ID -> same `chrome-extension://<id>` origin -> same
    // chrome.storage / IndexedDB / OPFS state.
    //
    // Do NOT change or remove this value. Once published, rotating the
    // key would orphan every existing user's data and the Web Store
    // would reject the upload anyway.
    key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmDCDXBbSJxZqfAPibiexjYp5CkVDhh9QHwn2Vb82gScMWpx6LNg4H8YLlnUnXr1wHUS2wTv7LYB5QPCzo2X8XSe44lJWD8TJNHdz+OQNNjAa52z4uNdN36evxUMwz0ro8oFnlY6vPJfoXCwekg0IMoyxJUwSTksdMthK66DlKplI7NOCtM4SmFacrPgfBiX58Kjg5k8vhiYtREgsSqnMSVb+BK1B0ZO6jsNsBeI8LC7kHhHLz4PUZLwzUMyrvzAENKtkTdv+kLpUDmMTFmNI6JoMmfaJwXto5eQhe42Itzp2PF/4ka2AkBeS6uo7JTwxsScSnBtCQoarqnfsDskESQIDAQAB",
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
      // Artifact runtime runs in a sandboxed page (opaque origin) so the
      // agent-authored HTML can use inline <script>. The per-artifact
      // CSP <meta> injected by buildIframeDoc further narrows connect-src
      // to the manifest's declared network allowlist.
      sandbox:
        "sandbox allow-scripts allow-forms allow-popups allow-modals; " +
        "script-src 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://esm.sh https://unpkg.com; " +
        "style-src 'unsafe-inline' https://cdn.jsdelivr.net https://esm.sh https://unpkg.com; " +
        "img-src * data: blob:; font-src * data:; connect-src *;",
    },
    sandbox: {
      pages: ["sandbox.html", "python-sandbox.html", "artifact-sandbox.html"],
    },
    icons: {
      "16": "icon/16.png",
      "32": "icon/32.png",
      "48": "icon/48.png",
      "128": "icon/128.png",
    },
    action: {},
    // Make newtab.html the Chrome new-tab page. Contrast with the
    // side_panel strip in the build:manifestGenerated hook above:
    // side_panel was stripped because Chrome injects it on every tab and
    // we want per-tab control. The new-tab override is the opposite — we
    // *do* want every Cmd-T to land on our chat surface.
    chrome_url_overrides: {
      newtab: "newtab.html",
    },
    permissions: [
      "tabs",
      "tabGroups",
      "storage",
      // Exempts this origin from quota limits AND from quota eviction.
      // Without it the extension's default bucket is "best-effort", and
      // Chrome deletes best-effort buckets whole — IndexedDB, OPFS and
      // Cache together — under storage pressure (low disk), least
      // recently used origin first. That is not hypothetical: a full
      // disk wiped a real profile's conversations, memory, Space files
      // and artifacts in one shot, and the LevelDB log recorded only
      // "Creating DB ... since it was missing".
      //
      // Everything the agent authors — conversations in IndexedDB,
      // memory markdown and Space uploads in OPFS — is local-only and
      // unrecoverable, so eviction is data loss, not a cold cache.
      //
      // This adds no install-time permission warning, so it is safe to
      // add to an already-published extension. See also
      // `ensurePersistedStorage()` in `@/lib/storage-persistence`.
      "unlimitedStorage",
      "offscreen",
      "activeTab",
      "alarms",
      "bookmarks",
      "history",
      "sessions",
      "sidePanel",
      "scripting",
      "debugger",
      "identity",
      "notifications",
    ],
    host_permissions: ["<all_urls>"],
    web_accessible_resources: [
      {
        resources: ["overlay.html", "icon/logo.svg", "icon/logo-dark.svg"],
        matches: ["<all_urls>"],
      },
    ],
    commands: {
      "open-home": {
        suggested_key: {
          default: "Alt+Shift+I",
          mac: "Alt+Shift+I",
        },
        description: "Open OpenBrowse home tab",
      },
      "open-search": {
        suggested_key: {
          default: "Alt+K",
          mac: "Alt+K",
        },
        description: "Open search overlay",
      },
      "open-global-chat": {
        suggested_key: {
          default: "Alt+Space",
          mac: "Alt+Space",
        },
        description: "Open Global AI chat popup",
      },
      "open-chat": {
        suggested_key: {
          default: "Alt+I",
          mac: "Alt+I",
        },
        description: "Open AI chat",
      },
    },
  }),
});
