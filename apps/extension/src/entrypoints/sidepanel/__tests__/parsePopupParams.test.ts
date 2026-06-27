import { describe, expect, it } from "vitest";
import { parsePopupParams } from "../parsePopupParams";

describe("parsePopupParams editArtifactId", () => {
  it("returns the editArtifactId when present", () => {
    const r = parsePopupParams("?editArtifactId=abc123");
    expect(r.editArtifactId).toBe("abc123");
  });

  it("returns null when editArtifactId is absent", () => {
    const r = parsePopupParams("?mode=popup");
    expect(r.editArtifactId).toBeNull();
  });

  it("returns null when editArtifactId is empty", () => {
    const r = parsePopupParams("?editArtifactId=");
    expect(r.editArtifactId).toBeNull();
  });

  it("decodes percent-encoded ids", () => {
    const r = parsePopupParams("?editArtifactId=a%20b");
    expect(r.editArtifactId).toBe("a b");
  });

  it("still parses the existing params alongside editArtifactId", () => {
    const r = parsePopupParams(
      "?mode=popup&globalChat=true&originWindowId=7&originTabId=9&conversationId=cid1&editArtifactId=art1",
    );
    expect(r.isPopupMode).toBe(true);
    expect(r.isGlobalChat).toBe(true);
    expect(r.originWindowId).toBe(7);
    expect(r.originTabId).toBe(9);
    expect(r.initialConversationId).toBe("cid1");
    expect(r.editArtifactId).toBe("art1");
  });
});

describe("parsePopupParams seedPrompt / autoSubmit", () => {
  it("decodes a percent-encoded seed prompt", () => {
    const r = parsePopupParams("?editArtifactId=a&prompt=Fix%20this%20error");
    expect(r.seedPrompt).toBe("Fix this error");
  });

  it("returns null seedPrompt when absent or empty", () => {
    expect(parsePopupParams("?editArtifactId=a").seedPrompt).toBeNull();
    expect(parsePopupParams("?prompt=").seedPrompt).toBeNull();
  });

  it("parses autoSubmit only when exactly '1'", () => {
    expect(parsePopupParams("?autoSubmit=1").autoSubmit).toBe(true);
    expect(parsePopupParams("?autoSubmit=true").autoSubmit).toBe(false);
    expect(parsePopupParams("?mode=popup").autoSubmit).toBe(false);
  });
});
