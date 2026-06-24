import { describe, expect, it } from "vitest";
import { executeOnPageTool } from "../tools/execute-on-page";

/**
 * The `parameters` schema on `executeOnPage` carries a refinement that
 * mirrors the documented contract: when inline `code` is set, `kind`
 * MUST be `"read"` or `"write"`. Without this rule, the model could
 * send `{ code: "...", /* kind omitted *​/ }` and the call would
 * validate; the `needsApproval` predicate would then route it through
 * the write path (defensive default), but the agent's intent would be
 * silently lost.
 *
 * `scriptRef`-only inputs are unaffected — the description explicitly
 * says `kind` is ignored when running by reference.
 */
describe("executeOnPage schema — `code → kind` refinement", () => {
  // The parameters schema is exposed on the tool for SDK use; we
  // exercise it here directly via .safeParse.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schema = (executeOnPageTool as any).parameters as {
    safeParse: (
      v: unknown,
    ) => { success: true } | { success: false; error: { issues: Array<{ path: ReadonlyArray<string | number>; message: string }> } };
  };

  it("rejects `code` without `kind`", () => {
    const r = schema.safeParse({
      tab: "t1",
      code: "return document.title;",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      // The refinement points at `kind` so the error surfaces there.
      expect(r.error.issues.some((i) => i.path.includes("kind"))).toBe(true);
    }
  });

  it("accepts `code` + `kind: 'read'`", () => {
    const r = schema.safeParse({
      tab: "t1",
      code: "return document.title;",
      kind: "read",
    });
    expect(r.success).toBe(true);
  });

  it("accepts `code` + `kind: 'write'`", () => {
    const r = schema.safeParse({
      tab: "t1",
      code: "document.querySelector('button').click();",
      kind: "write",
    });
    expect(r.success).toBe(true);
  });

  it("accepts `scriptRef` without `kind` (kind ignored for saved scripts)", () => {
    const r = schema.safeParse({
      tab: "t1",
      scriptRef: { skill: "linkedin.com", script: "list-recent-posts.js" },
    });
    expect(r.success).toBe(true);
  });

  it("accepts `scriptRef` with `kind` set (kind is ignored, but harmless)", () => {
    const r = schema.safeParse({
      tab: "t1",
      scriptRef: { skill: "linkedin.com", script: "list-recent-posts.js" },
      kind: "read",
    });
    expect(r.success).toBe(true);
  });

  it("accepts neither `code` nor `scriptRef` at the schema layer (the runtime branches catch this)", () => {
    // The schema doesn't enforce code-XOR-scriptRef; the tool's execute
    // body returns a clear error message when neither is set. We only
    // exercise the kind refinement here.
    const r = schema.safeParse({ tab: "t1" });
    expect(r.success).toBe(true);
  });
});
