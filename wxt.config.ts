import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/module-react"],
  webExt: {
    chromiumArgs: ["--user-data-dir=.wxt/chrome-data"],
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
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
    side_panel: {
      default_path: "sidepanel.html",
    },
    permissions: [
      "tabs",
      "tabGroups",
      "storage",
      "offscreen",
      "activeTab",
      "alarms",
      "bookmarks",
      "history",
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
