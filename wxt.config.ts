import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "wxt";
import fs from "node:fs";
import path from "node:path";
import { walkSkills } from "./src/build/walk-skills";

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
    },
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  hooks: {
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
  manifest: ({ mode }) => ({
    name: "OpenBrowse",
    description: "The open source browser agent.",
    version: "0.1.0",
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    sandbox: {
      pages: ["sandbox.html"],
    },
    icons: {
      "16": "icon/16.png",
      "32": "icon/32.png",
      "48": "icon/48.png",
      "128": "icon/128.png",
    },
    action: {},
    permissions: [
      "tabs",
      "tabGroups",
      "storage",
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
        resources: ["overlay.html", "icon/logo.svg"],
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
