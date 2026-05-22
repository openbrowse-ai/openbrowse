/**
 * Core snapshot capture logic, extracted so action tools (click/type/navigate)
 * can auto-attach post-action diffs to their responses without duplicating the
 * a11y tree logic from tools/snapshot.ts.
 *
 * All CDP I/O routes through the `BrowserDriver` passed in by callers, which
 * is what makes this module portable: in production it goes through
 * `chrome.debugger`; in the bench harness it goes through Playwright's CDP
 * session. No `chrome.*` references in here.
 */

import type { BrowserDriver, TabId } from "./driver";
import { setRefs, getPreviousSnapshot, type RefEntry } from "./ref-store";

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "combobox",
  "checkbox",
  "radio",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "switch",
  "slider",
  "searchbox",
  "option",
  "spinbutton",
  "treeitem",
]);

const SKIP_ROLES = new Set(["InlineTextBox", "none", "presentation"]);

interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value: string };
  name?: { value: string };
  value?: { value: string };
  properties?: { name: string; value: { value: unknown } }[];
  parentId?: string;
  childIds?: string[];
  backendDOMNodeId?: number;
}

interface TreeNode {
  axNode: AXNode;
  children: TreeNode[];
  ref: string | null;
  visible: boolean;
}

export interface CaptureResult {
  snapshotText: string;
  refs: Map<string, RefEntry>;
  previous: string | null;
  /**
   * Count of interactive elements that exist on the page but are below the
   * viewport fold (i.e. would become visible if the agent scrolled down).
   * Computed even when `viewportOnly` is false so the agent always knows
   * whether there's more to see.
   */
  belowFoldCount: number;
}

/**
 * Capture a fresh a11y snapshot, store refs, and return both the new text
 * and the previous snapshot (for diffing).
 */
export async function captureSnapshot(
  driver: BrowserDriver,
  tabId: TabId,
  opts: {
    mode?: "interactive" | "full";
    selector?: string;
    viewportOnly?: boolean;
  } = {},
): Promise<CaptureResult> {
  const mode = opts.mode ?? "interactive";
  const previous = getPreviousSnapshot(tabId);

  let rootBackendNodeId: number | undefined;
  if (opts.selector) {
    const evalResult = await driver.sendCommand<{
      result?: { objectId?: string };
    }>(tabId, "Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(opts.selector)})`,
      returnByValue: false,
    });
    if (evalResult.result?.objectId) {
      const desc = await driver.sendCommand<{
        node?: { backendNodeId?: number };
      }>(tabId, "DOM.describeNode", { objectId: evalResult.result.objectId });
      rootBackendNodeId = desc.node?.backendNodeId;
    }
  }

  let axTree = await driver.sendCommand<{ nodes: AXNode[] }>(
    tabId,
    "Accessibility.getFullAXTree",
  );

  if (!axTree.nodes || axTree.nodes.length === 0) {
    await new Promise((r) => setTimeout(r, 300));
    axTree = await driver.sendCommand<{ nodes: AXNode[] }>(
      tabId,
      "Accessibility.getFullAXTree",
    );
  }

  // Gather visibility info. We always fetch bounds (needed both for hidden
  // detection and for below-fold computation). Viewport filter runs only when
  // explicitly requested.
  const viewport = opts.viewportOnly ? await getViewportInfo(driver, tabId) : null;
  const { hiddenNodeIds, belowFoldBackendNodeIds } = await getVisibilityInfo(
    driver,
    tabId,
    viewport,
  );
  const cursorInteractive = await detectCursorInteractive(driver, tabId);

  let tree = buildTree(
    axTree.nodes,
    hiddenNodeIds,
    cursorInteractive,
    rootBackendNodeId,
  );
  if (rootBackendNodeId != null) {
    reassignRefs(tree);
  }

  const isInteractive = mode === "interactive";
  let snapshotText = renderTree(tree, isInteractive);
  let refs = collectRefs(tree);

  if (snapshotText.length === 0 && axTree.nodes.length > 0) {
    await new Promise((r) => setTimeout(r, 400));
    const retry = await driver.sendCommand<{ nodes: AXNode[] }>(
      tabId,
      "Accessibility.getFullAXTree",
    );
    const retryVis = await getVisibilityInfo(driver, tabId, viewport);
    const retryCursor = await detectCursorInteractive(driver, tabId);
    tree = buildTree(
      retry.nodes,
      retryVis.hiddenNodeIds,
      retryCursor,
      rootBackendNodeId,
    );
    if (rootBackendNodeId != null) reassignRefs(tree);
    snapshotText = renderTree(tree, isInteractive);
    refs = collectRefs(tree);
  }

  setRefs(tabId, refs, snapshotText);

  // Count refs whose backendNodeId falls below the fold. We do this by
  // walking the collected refs (which are guaranteed to be interactive
  // elements). When viewportOnly is true the below-fold elements were already
  // excluded, so we use the raw below-fold set size restricted to AX nodes.
  let belowFoldCount = 0;
  if (opts.viewportOnly) {
    // In viewport mode, the filtered-out refs are exactly the below-fold
    // interactive ones. We need to enumerate them from the AX tree directly.
    for (const node of axTree.nodes) {
      const role = node.role?.value ?? "";
      const backendId = node.backendDOMNodeId;
      if (!backendId || !belowFoldBackendNodeIds.has(backendId)) continue;
      if (!INTERACTIVE_ROLES.has(role)) continue;
      belowFoldCount++;
    }
  } else {
    // In normal mode, check how many of the currently-collected refs are
    // below the fold (they're still in the output, but the agent should know
    // scrolling will reveal NEW refs too).
    // Also count interactive AX nodes below fold that aren't currently in refs
    // (e.g. filtered for being inside hidden ancestors). Simpler: count refs.
    for (const entry of refs.values()) {
      if (belowFoldBackendNodeIds.has(entry.backendNodeId)) belowFoldCount++;
    }
  }

  return { snapshotText, refs, previous, belowFoldCount };
}

/**
 * Compute a line-level diff between two snapshots. Returns a short summary
 * suitable for auto-attaching to action responses.
 *
 * Returns null if the snapshots are identical (signals "no visible change",
 * often a silent action failure).
 */
export function diffSnapshots(
  previous: string,
  current: string,
  opts: { maxLines?: number } = {},
): string | null {
  const maxLines = opts.maxLines ?? 40;
  const prevLines = previous.split("\n");
  const currLines = current.split("\n");

  const prevSet = new Set(prevLines);
  const currSet = new Set(currLines);

  const added: string[] = [];
  const removed: string[] = [];

  for (const line of currLines) {
    if (!prevSet.has(line)) added.push(line);
  }
  for (const line of prevLines) {
    if (!currSet.has(line)) removed.push(line);
  }

  if (added.length === 0 && removed.length === 0) return null;

  // Navigation or major change — truncate and summarize
  const totalChanges = added.length + removed.length;
  if (totalChanges > maxLines) {
    const sampledAdded = added.slice(0, Math.floor(maxLines / 2));
    const sampledRemoved = removed.slice(0, Math.floor(maxLines / 2));
    const lines = [
      `[major change: ${added.length} added, ${removed.length} removed — showing first ${maxLines}]`,
      ...sampledAdded.map((l) => `[+] ${l.trim()}`),
      ...sampledRemoved.map((l) => `[-] ${l.trim()}`),
      `[call snapshot to see the full updated tree]`,
    ];
    return lines.join("\n");
  }

  return [
    ...added.map((l) => `[+] ${l.trim()}`),
    ...removed.map((l) => `[-] ${l.trim()}`),
  ].join("\n");
}

// ============================================================================
// Internal tree-building helpers (ported from tools/snapshot.ts)
// ============================================================================

function buildTree(
  nodes: AXNode[],
  hiddenNodeIds: Set<number>,
  cursorInteractive: Set<number>,
  scopeBackendNodeId?: number,
): TreeNode {
  let refCounter = 1;
  const treeNodes = new Map<string, TreeNode>();

  for (const node of nodes) {
    const role = node.role?.value ?? "";
    const backendId = node.backendDOMNodeId;
    const isRootLike =
      role === "RootWebArea" || role === "WebArea" || role === "document";
    const isHidden =
      !isRootLike && backendId != null && hiddenNodeIds.has(backendId);

    const isInteractive =
      INTERACTIVE_ROLES.has(role) ||
      (backendId != null && cursorInteractive.has(backendId));

    const shouldSkip = node.ignored || SKIP_ROLES.has(role) || isHidden;

    const ref = !shouldSkip && isInteractive ? `@e${refCounter++}` : null;

    treeNodes.set(node.nodeId, {
      axNode: node,
      children: [],
      ref,
      visible: !shouldSkip && !isHidden,
    });
  }

  let root: TreeNode | null = null;
  let scopeRoot: TreeNode | null = null;

  for (const node of nodes) {
    const treeNode = treeNodes.get(node.nodeId)!;
    if (node.parentId) {
      const parent = treeNodes.get(node.parentId);
      if (parent) parent.children.push(treeNode);
    } else {
      root = treeNode;
    }
    if (
      scopeBackendNodeId != null &&
      node.backendDOMNodeId === scopeBackendNodeId
    ) {
      scopeRoot = treeNode;
    }
  }

  if (scopeRoot) return scopeRoot;
  return root ?? { axNode: nodes[0], children: [], ref: null, visible: true };
}

function renderTree(
  root: TreeNode,
  interactiveOnly: boolean,
  hrefMap?: Map<number, string>,
  urlIdAssignments?: Map<number, number>,
): string {
  const lines: string[] = [];

  function walk(node: TreeNode, depth: number, ancestorHasRef: boolean) {
    const role = node.axNode.role?.value ?? "";
    if (role === "RootWebArea" || role === "WebArea") {
      for (const child of node.children) walk(child, depth, ancestorHasRef);
      return;
    }

    if (!node.visible) {
      if (node.children.length > 0) {
        for (const child of node.children) walk(child, depth, ancestorHasRef);
      }
      return;
    }

    const hasRefInSubtree =
      node.ref != null || node.children.some((c) => subtreeHasRef(c));

    if (interactiveOnly && !hasRefInSubtree) return;

    const name = node.axNode.name?.value ?? "";
    const value = node.axNode.value?.value;
    const props = formatProps(node.axNode);

    if (
      role === "generic" &&
      !name &&
      !node.ref &&
      node.children.length === 1
    ) {
      walk(node.children[0], depth, ancestorHasRef);
      return;
    }

    if (
      !node.ref &&
      !name &&
      isStructuralRole(role) &&
      node.children.length === 0
    ) {
      return;
    }

    const indent = "  ".repeat(depth);
    let line = indent;

    if (node.ref) line += `${node.ref} `;
    line += role;
    if (name) line += ` "${name}"`;
    if (value) line += `: "${value}"`;
    if (props) line += ` ${props}`;

    // Append urlId attribute for link-like nodes when a href map was provided.
    if (
      hrefMap &&
      urlIdAssignments &&
      (role === "link" || role === "menuitem") &&
      node.axNode.backendDOMNodeId != null
    ) {
      const href = hrefMap.get(node.axNode.backendDOMNodeId);
      if (href) {
        let urlId = urlIdAssignments.get(node.axNode.backendDOMNodeId);
        if (urlId == null) {
          urlId = urlIdAssignments.size + 1;
          urlIdAssignments.set(node.axNode.backendDOMNodeId, urlId);
        }
        line += ` [urlId=${urlId}]`;
      }
    }

    lines.push(line);

    for (const child of node.children) {
      walk(child, depth + 1, ancestorHasRef || node.ref != null);
    }
  }

  walk(root, 0, false);
  return lines.join("\n");
}

const subtreeHasRefCache = new WeakMap<TreeNode, boolean>();
function subtreeHasRef(node: TreeNode): boolean {
  const cached = subtreeHasRefCache.get(node);
  if (cached !== undefined) return cached;
  const result = node.ref != null || node.children.some((c) => subtreeHasRef(c));
  subtreeHasRefCache.set(node, result);
  return result;
}

function isStructuralRole(role: string): boolean {
  return ["generic", "group", "list", "listitem", "paragraph", "Section"].includes(
    role,
  );
}

function formatProps(node: AXNode): string {
  const parts: string[] = [];
  if (!node.properties) return "";

  for (const prop of node.properties) {
    const { name, value } = prop;
    if (name === "level" && value.value) parts.push(`level=${value.value}`);
    if (name === "checked" && value.value !== "false")
      parts.push(`checked=${value.value}`);
    if (name === "expanded") parts.push(`expanded=${value.value}`);
    if (name === "selected" && value.value === true) parts.push("selected");
    if (name === "disabled" && value.value === true) parts.push("disabled");
    if (name === "required" && value.value === true) parts.push("required");
    if (name === "focused" && value.value === true) parts.push("focused");
  }

  return parts.length > 0 ? `[${parts.join(", ")}]` : "";
}

function reassignRefs(root: TreeNode): void {
  let counter = 1;
  function walk(node: TreeNode) {
    if (node.ref) node.ref = `@e${counter++}`;
    for (const child of node.children) walk(child);
  }
  walk(root);
}

function collectRefs(root: TreeNode): Map<string, RefEntry> {
  const refs = new Map<string, RefEntry>();

  function walk(node: TreeNode) {
    if (node.ref && node.axNode.backendDOMNodeId != null) {
      refs.set(node.ref, {
        backendNodeId: node.axNode.backendDOMNodeId,
        role: node.axNode.role?.value ?? "",
        name: node.axNode.name?.value ?? "",
      });
    }
    for (const child of node.children) walk(child);
  }

  walk(root);
  return refs;
}

async function getViewportInfo(
  driver: BrowserDriver,
  tabId: TabId,
): Promise<{
  scrollY: number;
  viewportHeight: number;
} | null> {
  try {
    const result = await driver.sendCommand<{
      result?: { value?: { sy: number; vh: number } };
    }>(tabId, "Runtime.evaluate", {
      expression: `({ sy: window.scrollY, vh: window.innerHeight })`,
      returnByValue: true,
    });
    const v = result.result?.value;
    if (!v) return null;
    return { scrollY: v.sy, viewportHeight: v.vh };
  } catch {
    return null;
  }
}

/**
 * Single pass over `DOMSnapshot.captureSnapshot` that builds both:
 *  - `hiddenNodeIds`: backend node IDs that are display:none, visibility:hidden,
 *    opacity:0, zero-size, or (when a viewport is provided) below the fold.
 *  - `belowFoldBackendNodeIds`: backend node IDs that are strictly below the
 *    current viewport (regardless of visibility). Computed independently of
 *    `hiddenNodeIds` so callers can report how many refs would be revealed
 *    by scrolling even when no viewport filter is applied.
 */
async function getVisibilityInfo(
  driver: BrowserDriver,
  tabId: TabId,
  viewport: { scrollY: number; viewportHeight: number } | null,
): Promise<{
  hiddenNodeIds: Set<number>;
  belowFoldBackendNodeIds: Set<number>;
}> {
  const hidden = new Set<number>();
  const belowFold = new Set<number>();

  try {
    const snapshot = await driver.sendCommand<{
      documents: {
        nodes: {
          backendNodeId: number[];
          nodeName: number[];
          layoutNodeIndex: number[];
        };
        layout: {
          nodeIndex: number[];
          bounds: number[][];
          styles: number[][];
        };
      }[];
      strings: string[];
    }>(tabId, "DOMSnapshot.captureSnapshot", {
      computedStyles: ["display", "visibility", "opacity"],
      includeDOMRects: true,
    });

    if (!snapshot.documents?.[0]) return { hiddenNodeIds: hidden, belowFoldBackendNodeIds: belowFold };

    const doc = snapshot.documents[0];
    const strings = snapshot.strings ?? [];
    const layoutIndexMap = new Map<number, number>();
    for (let i = 0; i < doc.layout.nodeIndex.length; i++) {
      layoutIndexMap.set(doc.layout.nodeIndex[i], i);
    }

    const foldThreshold = viewport
      ? viewport.scrollY + viewport.viewportHeight
      : null;

    for (let i = 0; i < doc.nodes.backendNodeId.length; i++) {
      const backendId = doc.nodes.backendNodeId[i];
      const layoutIdx = layoutIndexMap.get(i);

      if (layoutIdx == null) {
        hidden.add(backendId);
        continue;
      }

      const bounds = doc.layout.bounds[layoutIdx];
      if (bounds && bounds[2] === 0 && bounds[3] === 0) {
        hidden.add(backendId);
        continue;
      }

      const styleIndices = doc.layout.styles?.[layoutIdx];
      if (styleIndices && styleIndices.length >= 3) {
        const display = strings[styleIndices[0]] ?? "";
        const visibility = strings[styleIndices[1]] ?? "";
        const opacity = strings[styleIndices[2]] ?? "";
        if (display === "none" || visibility === "hidden" || opacity === "0") {
          hidden.add(backendId);
          continue;
        }
      }

      // Below-fold check — bounds.y is in document coords.
      if (bounds && foldThreshold != null && bounds[1] > foldThreshold) {
        belowFold.add(backendId);
        // When a viewport filter is active, also treat below-fold as hidden so
        // the snapshot tree renderer excludes them.
        hidden.add(backendId);
        continue;
      }

      // Even without a viewport filter, still track below-fold so the tool
      // can report belowFoldCount. Compute once using the *current* viewport.
      if (bounds && viewport == null) {
        // We don't have viewport info — skip below-fold tracking.
      }
    }

    // If we didn't get a viewport (viewportOnly was false), take a second
    // cheap pass to compute below-fold counts for the agent's benefit.
    if (viewport == null) {
      const vp = await getViewportInfo(driver, tabId);
      if (vp) {
        const threshold = vp.scrollY + vp.viewportHeight;
        for (let i = 0; i < doc.nodes.backendNodeId.length; i++) {
          const layoutIdx = layoutIndexMap.get(i);
          if (layoutIdx == null) continue;
          const bounds = doc.layout.bounds[layoutIdx];
          if (bounds && bounds[1] > threshold) {
            belowFold.add(doc.nodes.backendNodeId[i]);
          }
        }
      }
    }
  } catch {
    // best-effort
  }

  return { hiddenNodeIds: hidden, belowFoldBackendNodeIds: belowFold };
}

async function detectCursorInteractive(
  driver: BrowserDriver,
  tabId: TabId,
): Promise<Set<number>> {
  const ids = new Set<number>();

  try {
    const result = await driver.sendCommand<{
      result?: { objectId?: string };
    }>(tabId, "Runtime.evaluate", {
      expression: `(function() {
        const els = [];
        const all = document.querySelectorAll('*');
        for (let i = 0; i < all.length && els.length < 100; i++) {
          const el = all[i];
          const style = getComputedStyle(el);
          if (style.cursor === 'pointer' || el.hasAttribute('onclick') ||
              (el.getAttribute('tabindex') !== null && el.getAttribute('tabindex') !== '-1') ||
              el.getAttribute('contenteditable') === 'true') {
            const tag = el.tagName.toLowerCase();
            if (!['a','button','input','select','textarea','label'].includes(tag) &&
                !el.getAttribute('role')) {
              els.push(el);
            }
          }
        }
        return els;
      })()`,
      returnByValue: false,
      awaitPromise: false,
    });

    if (!result.result?.objectId) return ids;

    const props = await driver.sendCommand<{
      result: { name: string; value?: { objectId?: string; subtype?: string } }[];
    }>(tabId, "Runtime.getProperties", {
      objectId: result.result.objectId,
      ownProperties: true,
    });

    for (const prop of props.result) {
      if (!/^\d+$/.test(prop.name)) continue;
      if (!prop.value?.objectId || prop.value.subtype === "null") continue;
      try {
        const node = await driver.sendCommand<{
          node?: { backendNodeId?: number };
        }>(tabId, "DOM.describeNode", { objectId: prop.value.objectId });
        if (node.node?.backendNodeId) {
          ids.add(node.node.backendNodeId);
        }
      } catch {
        // best-effort
      }
    }
  } catch {
    // best-effort
  }

  return ids;
}

/**
 * Collect `backendNodeId → absolute href` pairs for every `<a[href]>` and
 * `<area[href]>` on the page. Used by the extract tool to replace URLs with
 * numeric IDs in the snapshot (anti-hallucination) and rehydrate them after
 * the LLM call.
 */
async function collectLinkHrefs(
  driver: BrowserDriver,
  tabId: TabId,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();

  try {
    const evalResult = await driver.sendCommand<{
      result?: { objectId?: string };
    }>(tabId, "Runtime.evaluate", {
      expression: `Array.from(document.querySelectorAll('a[href], area[href]'))`,
      returnByValue: false,
    });

    if (!evalResult.result?.objectId) return out;

    const props = await driver.sendCommand<{
      result: {
        name: string;
        value?: { objectId?: string; subtype?: string };
      }[];
    }>(tabId, "Runtime.getProperties", {
      objectId: evalResult.result.objectId,
      ownProperties: true,
    });

    for (const prop of props.result) {
      if (!/^\d+$/.test(prop.name)) continue;
      if (!prop.value?.objectId || prop.value.subtype === "null") continue;

      try {
        const node = await driver.sendCommand<{
          node?: { backendNodeId?: number };
        }>(tabId, "DOM.describeNode", { objectId: prop.value.objectId });
        const backendId = node.node?.backendNodeId;
        if (backendId == null) continue;

        // Read the href property (already resolved to absolute URL by the
        // browser when accessed as a JS property, vs. the raw attribute).
        const hrefResult = await driver.sendCommand<{
          result?: { type: string; value?: unknown };
        }>(tabId, "Runtime.callFunctionOn", {
          functionDeclaration: "function() { return this.href; }",
          objectId: prop.value.objectId,
          returnByValue: true,
        });

        const href = hrefResult.result?.value;
        if (typeof href === "string" && href.length > 0) {
          out.set(backendId, href);
        }
      } catch {
        // individual link failed — skip it
      }
    }
  } catch {
    // eval-all failed; return partial map
  }

  return out;
}

export interface CaptureWithUrlsResult {
  snapshotText: string;
  refs: Map<string, RefEntry>;
  /**
   * Map from the numeric IDs emitted in the snapshot text as `[urlId=N]` to
   * the absolute URL string. The extract tool uses this to rehydrate URLs in
   * the LLM's structured output.
   */
  urlMap: Map<number, string>;
}

/**
 * Like `captureSnapshot` but renders link elements with `[urlId=N]` tokens
 * instead of inline URLs. Returns the integer → URL map so callers can
 * rehydrate URLs after an LLM call that emitted IDs.
 *
 * Used by the `extract` tool to prevent URL hallucination — the LLM never
 * sees full URLs, only small integers it can reference.
 */
export async function captureSnapshotWithUrlIds(
  driver: BrowserDriver,
  tabId: TabId,
  opts: { selector?: string } = {},
): Promise<CaptureWithUrlsResult> {
  let rootBackendNodeId: number | undefined;
  if (opts.selector) {
    const evalResult = await driver.sendCommand<{
      result?: { objectId?: string };
    }>(tabId, "Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(opts.selector)})`,
      returnByValue: false,
    });
    if (evalResult.result?.objectId) {
      const desc = await driver.sendCommand<{
        node?: { backendNodeId?: number };
      }>(tabId, "DOM.describeNode", { objectId: evalResult.result.objectId });
      rootBackendNodeId = desc.node?.backendNodeId;
    }
    if (rootBackendNodeId == null) {
      throw new Error(
        `Selector did not match any element on the page: ${opts.selector}. ` +
          `Tip: CSS attribute selectors like [role="main"] only match explicit ` +
          `attributes, not implicit ARIA roles. Try the element selector directly ` +
          `(e.g. "main"), an ID (e.g. "#search"), or omit selector to snapshot the whole page.`,
      );
    }
  }

  // Parallelize the three independent CDP collections.
  const [axTreeRaw, visibility, cursorInteractive, hrefs] = await Promise.all([
    driver.sendCommand<{ nodes: AXNode[] }>(tabId, "Accessibility.getFullAXTree"),
    getVisibilityInfo(driver, tabId, null),
    detectCursorInteractive(driver, tabId),
    collectLinkHrefs(driver, tabId),
  ]);

  let axTree = axTreeRaw;
  if (!axTree.nodes || axTree.nodes.length === 0) {
    await new Promise((r) => setTimeout(r, 300));
    axTree = await driver.sendCommand<{ nodes: AXNode[] }>(
      tabId,
      "Accessibility.getFullAXTree",
    );
  }

  const tree = buildTree(
    axTree.nodes,
    visibility.hiddenNodeIds,
    cursorInteractive,
    rootBackendNodeId,
  );
  if (rootBackendNodeId != null) {
    reassignRefs(tree);
  }

  // Use "full" rendering (not just interactive) — extraction needs to see
  // content elements like headings, text, cells. The URL-ID pass is the
  // only thing we actually need from this codepath.
  const urlIdAssignments = new Map<number, number>();
  const snapshotText = renderTree(tree, false, hrefs, urlIdAssignments);
  const refs = collectRefs(tree);

  // Build the final id → url map from the assignments.
  const urlMap = new Map<number, string>();
  for (const [backendId, id] of urlIdAssignments) {
    const href = hrefs.get(backendId);
    if (href) urlMap.set(id, href);
  }

  return { snapshotText, refs, urlMap };
}
