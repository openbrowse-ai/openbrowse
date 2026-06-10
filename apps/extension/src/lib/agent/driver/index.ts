/**
 * Platform-neutral exports for the agent's driver layer. Importing this
 * barrel pulls in only interfaces + the per-call `ToolContext` machinery —
 * nothing that depends on `chrome.*`. Safe to import from Node.js (the bench
 * harness) and from the extension alike.
 *
 * Extension-specific implementations (`ExtensionDriver`,
 * `ExtensionStorage`) live in `./extension` and must be imported explicitly
 * by code running in the Chrome runtime.
 */

export type {
  BrowserDriver,
  BrowserTabInfo,
  TabId,
} from "./browser-driver";
export type { ToolContext, ToolSession } from "./tool-context";
export {
  bindTabByHandle,
  handleForTab,
  resolveTabIdOrThrow,
  resolveTabOrThrow,
  ToolTabResolutionError,
} from "./tool-context";
