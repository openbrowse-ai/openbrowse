import { describe, expect, it } from "vitest";
import {
  HEADLESS_SYSTEM_PROMPT_PREFIX,
  applyHeadlessPrefix,
} from "../agent-transport";

/**
 * Tests for the headless-run system-prompt prefix injected at the
 * head of SYSTEM_PROMPT when `headless?.autoApprove === true`.
 *
 * Rationale (A9, A10): the base SYSTEM_PROMPT tells the agent that
 * tools like `closeTabs` and `Delete` "Require user approval". For
 * MCP-dispatched runs this is false — auto-approve is on and the
 * tools execute immediately. Without the prefix the agent emits
 * narration like "I'll wait for approval before closing the tab"
 * that ends up in the user's transcript despite no approval being
 * needed. The prefix establishes the actual operational posture so
 * the agent's emitted text matches its actual behaviour.
 */

describe("agent-transport — headless system-prompt prefix", () => {
  it("includes the headless-context heading", () => {
    expect(HEADLESS_SYSTEM_PROMPT_PREFIX).toContain("Headless run context");
  });

  it("tells the agent there is NO human approver", () => {
    expect(HEADLESS_SYSTEM_PROMPT_PREFIX).toContain(
      "NO human present to approve",
    );
  });

  it("instructs the agent NOT to emit narration about waiting for approval", () => {
    expect(HEADLESS_SYSTEM_PROMPT_PREFIX.toLowerCase()).toContain(
      "do not emit narration suggesting you are waiting for approval",
    );
  });

  it("names the approval-gated tools that auto-approve in this mode", () => {
    // Spot-check a few — the full list is documented in the prefix.
    const text = HEADLESS_SYSTEM_PROMPT_PREFIX;
    expect(text).toContain("closeTabs");
    expect(text).toContain("Write");
    expect(text).toContain("Delete");
    expect(text).toContain("executePython");
    expect(text).toContain("install_skill");
    expect(text).toContain("proposePlan");
  });

  it("flags destructive tools as needing deliberate use", () => {
    expect(HEADLESS_SYSTEM_PROMPT_PREFIX.toLowerCase()).toContain(
      "destructive tools",
    );
  });

  it("explains that consent was given UPFRONT via the host's authorization flow", () => {
    expect(HEADLESS_SYSTEM_PROMPT_PREFIX).toContain("UPFRONT");
    expect(HEADLESS_SYSTEM_PROMPT_PREFIX).toContain("authorization flow");
  });
});

describe("agent-transport — applyHeadlessPrefix", () => {
  it("prepends the prefix to the base prompt", () => {
    const result = applyHeadlessPrefix("BASE PROMPT");
    expect(result.startsWith("### Headless run context")).toBe(true);
    expect(result.endsWith("BASE PROMPT")).toBe(true);
  });

  it("preserves the base prompt verbatim (no replacement)", () => {
    const base = "BASE\nMULTILINE\nPROMPT";
    const result = applyHeadlessPrefix(base);
    expect(result).toContain(base);
  });

  it("separates prefix and base with a horizontal-rule sentinel so the model can detect the boundary", () => {
    // The prefix ends with `\n\n---\n\n`. Anything past that is the
    // original system prompt unchanged.
    const result = applyHeadlessPrefix("X");
    expect(result).toMatch(/\n---\n\nX$/);
  });
});
