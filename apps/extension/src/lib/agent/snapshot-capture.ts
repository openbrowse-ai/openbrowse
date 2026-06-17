/**
 * Core snapshot capture logic, extracted so action tools (click/type/press)
 * can auto-attach a fresh viewport-scoped snapshot to their responses without
 * duplicating the a11y tree logic from tools/snapshot.ts. The `snapshot` tool
 * additionally exposes an opt-in `diff: true` mode that uses `diffSnapshots`
 * to compare the new capture against the prior one.
 *
 * All CDP I/O routes through the `BrowserDriver` passed in by callers, which
 * is what makes this module portable: in production it goes through
 * `chrome.debugger`; in the bench harness it goes through Playwright's CDP
 * session. No `chrome.*` references in here.
 */

import { isCrossExtensionFrameError } from "./cdp-errors";
import type { BrowserDriver, TabId } from "./driver";
import {
  setRefs,
  getPreviousSnapshot,
  getPreviousSignals,
  type RefEntry,
} from "./ref-store";

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
  /** Present on nodes that belong to a child frame (CDP getFullAXTree). */
  frameId?: string;
}

interface TreeNode {
  axNode: AXNode;
  children: TreeNode[];
  ref: string | null;
  /** True when this node is an interactive element that should receive a ref. */
  interactive: boolean;
  /**
   * Occurrence index among nodes sharing this node's (frameId, role, name),
   * in document order. Stored on the ref entry so re-resolution can re-find
   * the element by (role, name, nth) from a fresh AX tree. Set by
   * `assignStableRefs`; only meaningful when `ref` is non-null.
   */
  nth: number;
  visible: boolean;
}

export interface CaptureResult {
  snapshotText: string;
  refs: Map<string, RefEntry>;
  /** A11y text from the previous snapshot, or null on first capture. */
  previous: string | null;
  /** Signals captured at this snapshot. */
  signals: PageStateSignals;
  /** Signals from the previous snapshot, or null on first capture. */
  previousSignals: PageStateSignals | null;
  /**
   * Count of interactive elements that exist on the page but are below the
   * viewport fold (i.e. would become visible if the agent scrolled down).
   * Computed even when `viewportOnly` is false so the agent always knows
   * whether there's more to see.
   */
  belowFoldCount: number;
  /**
   * Set when the snapshot ran in a degraded mode — currently only when one
   * or more frames had to be excluded because they belong to another
   * Chrome extension (commonly password-manager iframes like 1Password).
   * Tools surface this verbatim to the agent so it knows the snapshot
   * still represents the actionable parts of the page even though the
   * walk wasn't whole-tree.
   */
  note?: string;
}

export interface PageStateSignals {
  focusedBackendNodeId: number | null;
  focusedName: string | null;
  focusedRole: string | null;
  expandedCount: number;
  pressedCount: number;
  checkedCount: number;
  dialogCount: number;
  url: string;
  // Note: `interactiveCount` was removed because it was mode-fragile —
  // capturing the same page under different modes (viewport vs full)
  // produces wildly different counts even when nothing visible changed.
  // See `describeSignalChanges` for the reasoning. Don't reintroduce
  // unless paired with a mode-aware comparison strategy.
}

/**
 * Derive multi-signal page state from an already-fetched AX tree and the
 * current URL. Pure function — no I/O — so it's cheap and unit-testable.
 *
 * Signals are intentionally counts rather than node lists: they're robust
 * (a count won't change without a real state shift) and small (no risk of
 * blowing up the diff payload on large pages).
 */
export function derivePageStateSignals(
  axNodes: AXNode[],
  url: string,
): PageStateSignals {
  let focusedBackendNodeId: number | null = null;
  let focusedName: string | null = null;
  let focusedRole: string | null = null;
  let expandedCount = 0;
  let pressedCount = 0;
  let checkedCount = 0;
  let dialogCount = 0;

  for (const node of axNodes) {
    const role = node.role?.value ?? "";
    if (role === "dialog" || role === "alertdialog") dialogCount++;

    const props = node.properties ?? [];
    let isFocused = false;
    for (const p of props) {
      const v = p.value?.value;
      if (p.name === "focused" && v === true) isFocused = true;
      if (p.name === "expanded" && v === true) expandedCount++;
      if (p.name === "pressed" && v === true) pressedCount++;
      if (p.name === "checked" && v === true) checkedCount++;
    }

    if (
      focusedBackendNodeId == null &&
      isFocused &&
      node.backendDOMNodeId != null
    ) {
      focusedBackendNodeId = node.backendDOMNodeId;
      focusedName = node.name?.value ?? null;
      focusedRole = role || null;
    }
  }

  return {
    focusedBackendNodeId,
    focusedName,
    focusedRole,
    expandedCount,
    pressedCount,
    checkedCount,
    dialogCount,
    url,
  };
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
  const previousSignals = getPreviousSignals(tabId);

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

  let axFetch = await fetchAxNodesAvoidingForeignFrames(driver, tabId);
  let axTree: { nodes: AXNode[] } = { nodes: axFetch.nodes };
  let frameNote = axFetch.note;

  if (!axTree.nodes || axTree.nodes.length === 0) {
    await new Promise((r) => setTimeout(r, 300));
    axFetch = await fetchAxNodesAvoidingForeignFrames(driver, tabId);
    axTree = { nodes: axFetch.nodes };
    frameNote = axFetch.note ?? frameNote;
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
  // Assign content-stable refs over the built hierarchy. Runs for every
  // capture (scoped or not) so the same logical element keeps the same @ref
  // across snapshots, surviving re-renders on virtualized pages.
  assignStableRefs(tree);

  const isInteractive = mode === "interactive";
  let snapshotText = renderTree(tree, isInteractive);
  let refs = collectRefs(tree);

  if (snapshotText.length === 0 && axTree.nodes.length > 0) {
    await new Promise((r) => setTimeout(r, 400));
    const retry = await fetchAxNodesAvoidingForeignFrames(driver, tabId);
    const retryVis = await getVisibilityInfo(driver, tabId, viewport);
    const retryCursor = await detectCursorInteractive(driver, tabId);
    tree = buildTree(
      retry.nodes,
      retryVis.hiddenNodeIds,
      retryCursor,
      rootBackendNodeId,
    );
    assignStableRefs(tree);
    snapshotText = renderTree(tree, isInteractive);
    refs = collectRefs(tree);
    axTree = { nodes: retry.nodes }; // keep axTree in sync for downstream signal + belowFoldCount derivation.
    frameNote = retry.note ?? frameNote;
  }

  // Fetch current URL for the URL signal. Cheap CDP call.
  let url = "";
  try {
    const targetInfo = await driver.sendCommand<{
      targetInfo?: { url?: string };
    }>(tabId, "Target.getTargetInfo");
    url = targetInfo.targetInfo?.url ?? "";
  } catch {
    // If we can't get the URL (rare), leave it as "". A "" → "" diff is a no-op
    // signal, so this is safe.
  }

  const signals = derivePageStateSignals(axTree.nodes, url);

  setRefs(tabId, refs, snapshotText, signals);

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

  return {
    snapshotText,
    refs,
    previous,
    signals,
    previousSignals,
    belowFoldCount,
    ...(frameNote ? { note: frameNote } : {}),
  };
}

/**
 * Compute a diff between two snapshots that combines the line-level a11y
 * text diff with a multi-signal state diff. Returns a short summary suitable
 * for the `snapshot` tool's opt-in `diff: true` mode.
 *
 * Returns null ONLY when text AND all signals are identical — i.e. nothing
 * observable changed. This is intentionally narrower than a text-only
 * set-diff: many successful interactions (focus, toggles, modal opens)
 * leave the a11y text identical, but signal changes still surface them.
 *
 * NOTE: action tools (clickElement/typeInElement/pressKey) intentionally do
 * NOT call this — they auto-attach a fresh viewport snapshot to their
 * responses instead of a diff, because mode-asymmetry between the prior
 * snapshot (often viewport-scoped) and a post-action capture (full-tree by
 * default) historically produced spurious "[+] entire below-fold tree"
 * diffs that drove model hallucinations.
 */
export function diffSnapshots(
  prev: { text: string; signals: PageStateSignals },
  curr: { text: string; signals: PageStateSignals },
  opts: { maxLines?: number } = {},
): string | null {
  const maxLines = opts.maxLines ?? 40;
  const prevLines = prev.text.split("\n");
  const currLines = curr.text.split("\n");

  const prevSet = new Set(prevLines);
  const currSet = new Set(currLines);

  const added: string[] = [];
  const removed: string[] = [];
  for (const line of currLines) if (!prevSet.has(line)) added.push(line);
  for (const line of prevLines) if (!currSet.has(line)) removed.push(line);

  // Text-changing case: return the existing-style line diff, unchanged.
  if (added.length > 0 || removed.length > 0) {
    const totalChanges = added.length + removed.length;
    if (totalChanges > maxLines) {
      const sampledAdded = added.slice(0, Math.floor(maxLines / 2));
      const sampledRemoved = removed.slice(0, Math.floor(maxLines / 2));
      return [
        `[major change: ${added.length} added, ${removed.length} removed — showing first ${maxLines}]`,
        ...sampledAdded.map((l) => `[+] ${l.trim()}`),
        ...sampledRemoved.map((l) => `[-] ${l.trim()}`),
        `[call snapshot to see the full updated tree]`,
      ].join("\n");
    }
    return [
      ...added.map((l) => `[+] ${l.trim()}`),
      ...removed.map((l) => `[-] ${l.trim()}`),
    ].join("\n");
  }

  // Text identical: check signal diff.
  const signalChanges = describeSignalChanges(prev.signals, curr.signals);
  if (signalChanges.length > 0) {
    return `[no a11y text change, but: ${signalChanges.join("; ")}]`;
  }

  return null;
}

/**
 * Render per-signal change descriptions. Returns one human-readable string
 * per signal that changed; empty array means signals are identical.
 *
 * Historical note: `interactiveCount` used to live on PageStateSignals and
 * be reported here. It was removed entirely because it's mode-fragile —
 * capturing the same page under different modes (viewport vs full) yields
 * wildly different counts. The auto-attached-diff history surfaced this
 * as spurious "interactive elements: N → M" lines that drove model
 * hallucinations. Don't reintroduce without a mode-aware comparison.
 */
function describeSignalChanges(
  prev: PageStateSignals,
  curr: PageStateSignals,
): string[] {
  const out: string[] = [];

  // Focus.
  if (prev.focusedBackendNodeId !== curr.focusedBackendNodeId) {
    const prevLabel = formatFocusLabel(prev);
    const currLabel = formatFocusLabel(curr);
    out.push(`focus moved from «${prevLabel}» to «${currLabel}»`);
  }

  // Toggle counts.
  if (prev.expandedCount !== curr.expandedCount) {
    out.push(`aria-expanded count: ${prev.expandedCount} → ${curr.expandedCount}`);
  }
  if (prev.pressedCount !== curr.pressedCount) {
    out.push(`aria-pressed count: ${prev.pressedCount} → ${curr.pressedCount}`);
  }
  if (prev.checkedCount !== curr.checkedCount) {
    out.push(`aria-checked count: ${prev.checkedCount} → ${curr.checkedCount}`);
  }

  // Dialog count — special-case 0↔N transitions.
  if (prev.dialogCount !== curr.dialogCount) {
    if (prev.dialogCount === 0 && curr.dialogCount > 0) out.push("dialog opened");
    else if (curr.dialogCount === 0 && prev.dialogCount > 0) out.push("dialog closed");
    else out.push(`dialog count: ${prev.dialogCount} → ${curr.dialogCount}`);
  }

  // URL. Skip when either side is empty: an empty URL means the
  // `Target.getTargetInfo` fetch failed (or this is the first capture), not a
  // real navigation — diffing against "" would emit a spurious "navigated to ".
  if (prev.url !== "" && curr.url !== "" && prev.url !== curr.url) {
    out.push(`navigated to ${curr.url}`);
  }

  return out;
}

function formatFocusLabel(signals: PageStateSignals): string {
  if (signals.focusedName && signals.focusedName.trim().length > 0) {
    return signals.focusedName;
  }
  if (signals.focusedBackendNodeId != null) {
    return `node#${signals.focusedBackendNodeId}`;
  }
  return "none";
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

    // Refs are assigned later by `assignStableRefs`, which walks the built
    // hierarchy so it can compute a content-stable id (role + name +
    // landmark + occurrence). Here we only record WHETHER the node is a
    // ref-worthy interactive element.
    const interactive = !shouldSkip && isInteractive;

    treeNodes.set(node.nodeId, {
      axNode: node,
      children: [],
      ref: null,
      interactive,
      nth: 0,
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
  if (root) return root;
  // No root and no scoped root — common when every frame's AX call failed
  // (e.g. a hostile cross-extension iframe was the ONLY frame the helper
  // could see). Return a synthetic empty tree rather than dereferencing
  // `nodes[0]` (which is undefined and crashes downstream `walk()`).
  // Synthetic root mirrors the shape `walk()` and `renderTree()` expect:
  // an AXNode with empty role/name and no children, treated as visible.
  return {
    axNode: { nodeId: "__empty__", role: { value: "" }, name: { value: "" } },
    children: [],
    ref: null,
    interactive: false,
    nth: 0,
    visible: true,
  };
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

/**
 * Assigns a content-stable `@ref` id to every interactive node in the tree.
 *
 * Unlike the old ordinal scheme (`@e1`, `@e2`, … reassigned every capture),
 * the id here is derived from the element's identity:
 *   role + accessible name + nearest landmark (region/nav/main/…) context
 *   + an occurrence index disambiguating siblings that share that signature.
 *
 * The signature is hashed to a short, stable token `@e<base36>`. Because the
 * token depends only on content/structure — not on how many interactive
 * nodes happen to precede it — the SAME logical element keeps the SAME ref
 * across snapshots even when the page re-renders, adds, or removes unrelated
 * elements. This is what lets a ref taken from one snapshot still resolve
 * after a later one, and what stops diffs from showing phantom
 * `[-]@e114 / [+]@e117` churn for elements that did not actually change.
 *
 * Collision handling: two genuinely distinct elements with an identical
 * (role, name, landmark) signature — e.g. a list of identical "Connect"
 * buttons — are disambiguated by their occurrence index within that
 * signature group, so each still gets a unique, stable ref.
 */
function assignStableRefs(root: TreeNode): void {
  // Count how many times each base signature has been seen so far, so
  // repeated (role,name,landmark) groups get a stable incrementing index.
  const seen = new Map<string, number>();
  // Separately count (frameId, role, name) occurrences in document order.
  // This `nth` is what re-resolution re-finds by from a fresh AX tree — it
  // must match the role/name counting that `findNodeByRoleNameNth` does, so
  // it is intentionally NOT landmark-scoped.
  const tupleSeen = new Map<string, number>();
  // Guard against the astronomically-unlikely case of two different
  // signatures hashing to the same token within one snapshot.
  const used = new Set<string>();

  function landmarkLabel(role: string, name: string): string | null {
    if (LANDMARK_ROLES.has(role)) {
      return name ? `${role}:${name}` : role;
    }
    return null;
  }

  function walk(node: TreeNode, landmarkPath: string): void {
    const role = node.axNode.role?.value ?? "";
    const name = node.axNode.name?.value ?? "";

    // Extend the landmark path when entering a landmark/region node.
    const lm = landmarkLabel(role, name);
    const childPath = lm ? (landmarkPath ? `${landmarkPath}>${lm}` : lm) : landmarkPath;

    if (node.interactive) {
      const baseSig = `${landmarkPath}|${role}|${name}`;
      const occurrence = seen.get(baseSig) ?? 0;
      seen.set(baseSig, occurrence + 1);
      const fullSig = `${baseSig}#${occurrence}`;

      let token = `@e${hashSignature(fullSig)}`;
      // Extremely unlikely collision fallback: salt until unique.
      let salt = 0;
      while (used.has(token)) {
        salt++;
        token = `@e${hashSignature(`${fullSig}~${salt}`)}`;
      }
      used.add(token);
      node.ref = token;

      // Frame-scoped (role, name) occurrence index for tuple re-resolution.
      const frameKey = `${node.axNode.frameId ?? ""}|${role}|${name}`;
      const nth = tupleSeen.get(frameKey) ?? 0;
      tupleSeen.set(frameKey, nth + 1);
      node.nth = nth;
    }

    for (const child of node.children) walk(child, childPath);
  }

  walk(root, "");
}

/** Roles that establish a landmark/region context for ref signatures. */
const LANDMARK_ROLES = new Set([
  "banner",
  "navigation",
  "main",
  "complementary",
  "contentinfo",
  "region",
  "search",
  "form",
  "article",
  "dialog",
  "alertdialog",
]);

/**
 * Deterministic, compact hash of a signature string → base36 token.
 * FNV-1a (32-bit) keeps it small, fast, and dependency-free. Used only to
 * shorten the human-unreadable signature into a stable `@e…` handle; it is
 * never persisted or relied on for security.
 */
function hashSignature(sig: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < sig.length; i++) {
    h ^= sig.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts to stay in integer range.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

function collectRefs(root: TreeNode): Map<string, RefEntry> {
  const refs = new Map<string, RefEntry>();

  function walk(node: TreeNode) {
    if (node.ref && node.axNode.backendDOMNodeId != null) {
      refs.set(node.ref, {
        backendNodeId: node.axNode.backendDOMNodeId,
        role: node.axNode.role?.value ?? "",
        name: node.axNode.name?.value ?? "",
        nth: node.nth,
        ...(node.axNode.frameId ? { frameId: node.axNode.frameId } : {}),
      });
    }
    for (const child of node.children) walk(child);
  }

  walk(root);
  return refs;
}

/**
 * Result of a frame-aware AX-tree fetch. Concatenates `getFullAXTree` nodes
 * from every frame the debugger could safely walk, and surfaces a `note`
 * naming any frames we excluded (currently only cross-extension iframes —
 * 1Password, LastPass, etc. — which Chrome refuses to expose to a
 * cross-extension debugger). Snapshots are still actionable on the
 * remaining frames; the note is propagated up to the agent so it knows
 * the snapshot isn't whole-tree.
 */
interface AxFetchResult {
  nodes: AXNode[];
  note?: string;
}

interface FrameNode {
  frame: { id: string; url?: string };
  childFrames?: FrameNode[];
}

/**
 * Best-effort lookup of OUR extension's `chrome-extension://<id>/` prefix.
 * Used to distinguish frames from this extension (always safe to walk —
 * the debugger can inspect its own surfaces) from frames belonging to a
 * DIFFERENT extension (Chrome refuses access). Returns undefined in
 * non-extension runtimes (tests, bench harness), in which case we
 * conservatively treat all `chrome-extension://` frames as foreign.
 *
 * Indirected through `globalThis` so this module typechecks in
 * `packages/bench` without `@types/chrome` and runs cleanly in the
 * Node-side test runner.
 */
function getOwnExtensionUrlPrefix(): string | undefined {
  const c = (globalThis as { chrome?: { runtime?: { id?: string } } })
    .chrome;
  const id = c?.runtime?.id;
  return id ? `chrome-extension://${id}/` : undefined;
}

/**
 * Walk a `Page.getFrameTree` result and bucket frames into "safe to AX-walk"
 * vs "foreign chrome-extension://". The bench harness and tests omit the
 * own-extension prefix, in which case all `chrome-extension://` frames are
 * conservatively bucketed as foreign.
 */
function classifyFrames(
  root: FrameNode,
  ownPrefix: string | undefined,
): { safe: { id: string; url: string | undefined }[]; foreignUrls: string[] } {
  const safe: { id: string; url: string | undefined }[] = [];
  const foreignUrls: string[] = [];
  function visit(node: FrameNode): void {
    const url = node.frame.url;
    const isExtUrl = !!url && url.startsWith("chrome-extension://");
    const isOurOwn = !!url && !!ownPrefix && url.startsWith(ownPrefix);
    if (isExtUrl && !isOurOwn) {
      foreignUrls.push(url ?? "(unknown)");
    } else {
      safe.push({ id: node.frame.id, url });
    }
    for (const child of node.childFrames ?? []) visit(child);
  }
  visit(root);
  return { safe, foreignUrls };
}

/**
 * Fetch the page's AX nodes in a way that doesn't blow up on cross-extension
 * iframes (e.g. password-manager content scripts). Strategy:
 *
 *   1. Pre-pass `Page.getFrameTree` to enumerate frames.
 *   2. Bucket frames by URL: foreign `chrome-extension://` frames are skipped
 *      preemptively, all others are walked individually with
 *      `Accessibility.getFullAXTree({frameId})` and concatenated.
 *   3. If a per-frame walk *itself* raises `isCrossExtensionFrameError`
 *      (race: an iframe was injected between the frameTree pre-pass and the
 *      AX call), skip that frame too and add it to the note.
 *   4. If `Page.getFrameTree` itself fails (older Chrome, or a target type
 *      that doesn't enable Page domain), fall back to the legacy whole-tree
 *      `getFullAXTree()` call so the snapshot still works on benign pages.
 *
 * Returns the concatenated AX nodes plus an optional note describing any
 * excluded frames. Throws only if EVERY safe frame's AX walk fails for a
 * non-cross-extension reason — callers can then decide whether to retry,
 * surface the error, or degrade to no AX tree at all.
 */
async function fetchAxNodesAvoidingForeignFrames(
  driver: BrowserDriver,
  tabId: TabId,
): Promise<AxFetchResult> {
  let frameTree: FrameNode | undefined;
  try {
    const result = await driver.sendCommand<{ frameTree?: FrameNode }>(
      tabId,
      "Page.getFrameTree",
    );
    frameTree = result.frameTree;
  } catch {
    // Page domain unavailable (rare). Fall through to legacy whole-tree.
  }

  if (!frameTree) {
    const tree = await driver.sendCommand<{ nodes: AXNode[] }>(
      tabId,
      "Accessibility.getFullAXTree",
    );
    return { nodes: tree.nodes ?? [] };
  }

  const ownPrefix = getOwnExtensionUrlPrefix();
  const { safe, foreignUrls } = classifyFrames(frameTree, ownPrefix);

  const allNodes: AXNode[] = [];
  const racedFrames: string[] = [];
  let lastNonClassifiedError: unknown = null;
  let anySucceeded = false;

  for (const frame of safe) {
    try {
      const tree = await driver.sendCommand<{ nodes: AXNode[] }>(
        tabId,
        "Accessibility.getFullAXTree",
        { frameId: frame.id },
      );
      if (tree.nodes && tree.nodes.length > 0) {
        for (const n of tree.nodes) allNodes.push(n);
      }
      anySucceeded = true;
    } catch (err) {
      if (isCrossExtensionFrameError(err)) {
        // Race: a cross-extension iframe was injected between getFrameTree
        // and the per-frame AX call. Record and continue.
        racedFrames.push(frame.url ?? frame.id);
        continue;
      }
      // Real error from this frame. Keep going so a single broken frame
      // can't kill the whole snapshot, but remember the last error in case
      // every frame fails (then we re-throw at the end).
      lastNonClassifiedError = err;
    }
  }

  if (!anySucceeded && lastNonClassifiedError) {
    throw lastNonClassifiedError;
  }

  const excluded = [...foreignUrls, ...racedFrames];
  if (excluded.length === 0) {
    return { nodes: allNodes };
  }

  // Compact, agent-actionable note. Truncate URLs because chrome-extension
  // ones can be very long; the host id is the useful part.
  const sample = excluded
    .slice(0, 3)
    .map((u) => {
      const m = u.match(/^chrome-extension:\/\/([a-z]+)\//i);
      return m ? `chrome-extension://${m[1]}/…` : u.slice(0, 80);
    })
    .join(", ");
  const more =
    excluded.length > 3 ? ` (+${excluded.length - 3} more)` : "";
  const note =
    `Snapshot excluded ${excluded.length} frame${excluded.length === 1 ? "" : "s"} ` +
    `belonging to other Chrome extensions (e.g. password managers): ${sample}${more}. ` +
    `Interactive elements in the main page are unaffected.`;

  return { nodes: allNodes, note };
}

/**
 * Re-find an element's CURRENT backendNodeId by its stable identity tuple
 * `(role, name, nth)` from a freshly-fetched accessibility tree, scoped to a
 * frame. This is the tuple-based recovery agent-browser uses: when a cached
 * backendNodeId goes stale (the element's DOM node was recreated on a
 * re-render), the ref string may also have changed if its name shifted — but
 * the stored identity tuple still points at the same logical element, so we
 * count (role, name) matches in document order and return the nth one.
 *
 * Returns null when no matching element exists (genuinely gone) or on CDP
 * error, so callers can fall through to their existing "stale" handling.
 *
 * `frameId` is threaded through for parity with cross-frame resolution; the
 * current single-session driver ignores it for same-process frames, and
 * cross-origin (OOPIF) session routing remains a follow-up.
 */
export async function findNodeByRoleNameNth(
  driver: BrowserDriver,
  tabId: TabId,
  role: string,
  name: string,
  nth: number,
  _frameId?: string,
): Promise<number | null> {
  let axTree: { nodes: AXNode[] };
  try {
    axTree = await driver.sendCommand<{ nodes: AXNode[] }>(
      tabId,
      "Accessibility.getFullAXTree",
    );
  } catch {
    return null;
  }

  let matchCount = 0;
  for (const node of axTree.nodes) {
    if (node.ignored) continue;
    if ((node.role?.value ?? "") !== role) continue;
    if ((node.name?.value ?? "") !== name) continue;
    if (matchCount === nth) {
      return node.backendDOMNodeId ?? null;
    }
    matchCount++;
  }
  return null;
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

  // Parallelize the three independent CDP collections. The AX walk uses
  // the frame-aware path so a cross-extension iframe (e.g. password manager)
  // can't kill the whole snapshot; foreign frames are silently excluded.
  const [axFetch, visibility, cursorInteractive, hrefs] = await Promise.all([
    fetchAxNodesAvoidingForeignFrames(driver, tabId),
    getVisibilityInfo(driver, tabId, null),
    detectCursorInteractive(driver, tabId),
    collectLinkHrefs(driver, tabId),
  ]);

  let axTree: { nodes: AXNode[] } = { nodes: axFetch.nodes };
  if (!axTree.nodes || axTree.nodes.length === 0) {
    await new Promise((r) => setTimeout(r, 300));
    const retry = await fetchAxNodesAvoidingForeignFrames(driver, tabId);
    axTree = { nodes: retry.nodes };
  }

  const tree = buildTree(
    axTree.nodes,
    visibility.hiddenNodeIds,
    cursorInteractive,
    rootBackendNodeId,
  );
  assignStableRefs(tree);

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
