import { describe, expect, it } from "vitest";
import {
  derivePageStateSignals,
  type PageStateSignals,
} from "../snapshot-capture";

// Minimal AXNode shape used by derivePageStateSignals. We don't import the
// internal AXNode interface — we mirror only the fields the function reads.
type FixtureAXNode = {
  nodeId: string;
  role?: { value: string };
  name?: { value: string };
  properties?: { name: string; value: { value: unknown } }[];
  backendDOMNodeId?: number;
};

describe("derivePageStateSignals", () => {
  it("returns zero/null signals for an empty AX tree", () => {
    const signals = derivePageStateSignals([], "https://example.com");
    expect(signals).toEqual<PageStateSignals>({
      focusedBackendNodeId: null,
      focusedName: null,
      focusedRole: null,
      expandedCount: 0,
      pressedCount: 0,
      checkedCount: 0,
      dialogCount: 0,
      url: "https://example.com",
    });
  });
});

describe("derivePageStateSignals — focus", () => {
  it("populates focused fields when a node has focused=true", () => {
    const node: FixtureAXNode = {
      nodeId: "1",
      role: { value: "textbox" },
      name: { value: "Email" },
      backendDOMNodeId: 42,
      properties: [{ name: "focused", value: { value: true } }],
    };
    const signals = derivePageStateSignals(
      // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
      [node as any],
      "https://example.com",
    );
    expect(signals.focusedBackendNodeId).toBe(42);
    expect(signals.focusedName).toBe("Email");
    expect(signals.focusedRole).toBe("textbox");
  });

  it("leaves focus null when no node is focused", () => {
    const node: FixtureAXNode = {
      nodeId: "1",
      role: { value: "textbox" },
      name: { value: "Email" },
      backendDOMNodeId: 42,
      properties: [],
    };
    const signals = derivePageStateSignals(
      // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
      [node as any],
      "https://example.com",
    );
    expect(signals.focusedBackendNodeId).toBeNull();
    expect(signals.focusedName).toBeNull();
    expect(signals.focusedRole).toBeNull();
  });
});

describe("derivePageStateSignals — toggle counts", () => {
  it("counts aria-expanded=true nodes", () => {
    const nodes: FixtureAXNode[] = [
      {
        nodeId: "1",
        role: { value: "button" },
        properties: [{ name: "expanded", value: { value: true } }],
      },
      {
        nodeId: "2",
        role: { value: "button" },
        properties: [{ name: "expanded", value: { value: false } }],
      },
      {
        nodeId: "3",
        role: { value: "button" },
        properties: [{ name: "expanded", value: { value: true } }],
      },
    ];
    const signals = derivePageStateSignals(
      // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
      nodes as any,
      "https://example.com",
    );
    expect(signals.expandedCount).toBe(2);
  });

  it("counts aria-pressed and aria-checked independently", () => {
    const nodes: FixtureAXNode[] = [
      {
        nodeId: "1",
        role: { value: "button" },
        properties: [{ name: "pressed", value: { value: true } }],
      },
      {
        nodeId: "2",
        role: { value: "checkbox" },
        properties: [{ name: "checked", value: { value: true } }],
      },
    ];
    const signals = derivePageStateSignals(
      // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
      nodes as any,
      "https://example.com",
    );
    expect(signals.pressedCount).toBe(1);
    expect(signals.checkedCount).toBe(1);
    expect(signals.expandedCount).toBe(0);
  });
});

describe("derivePageStateSignals — dialog count", () => {
  it("counts dialog and alertdialog roles", () => {
    const nodes: FixtureAXNode[] = [
      { nodeId: "1", role: { value: "dialog" } },
      { nodeId: "2", role: { value: "alertdialog" } },
      { nodeId: "3", role: { value: "button" } },
    ];
    const signals = derivePageStateSignals(
      // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
      nodes as any,
      "https://example.com",
    );
    expect(signals.dialogCount).toBe(2);
  });
});

// `interactiveCount` was removed (it was mode-fragile and dead code after
// the diff→viewport-snapshot migration). The signal lived only to power
// `describeSignalChanges`, which now intentionally excludes it. Don't
// reintroduce without a mode-aware comparison strategy.

describe("derivePageStateSignals — url", () => {
  it("stores the url verbatim", () => {
    const signals = derivePageStateSignals([], "https://x.test/a?b=c");
    expect(signals.url).toBe("https://x.test/a?b=c");
  });
});
