import { describe, expect, it } from "vitest";
import { computeButtonMode } from "../chat-input-mode";

/**
 * Pure-logic tests for the tri-state Send / Stop / Queue button.
 *
 * The full ChatInput component test would require RTL + jsdom which
 * the project hasn't pulled in yet. The branching matrix is the
 * interesting bit, so we test it directly via the exported helper.
 */
describe("computeButtonMode", () => {
  describe("not loading (status = ready)", () => {
    it("returns 'send' regardless of content", () => {
      expect(
        computeButtonMode({
          editMode: false,
          isLoading: false,
          hasContent: false,
          hasOnQueue: true,
        }),
      ).toBe("send");
      expect(
        computeButtonMode({
          editMode: false,
          isLoading: false,
          hasContent: true,
          hasOnQueue: false,
        }),
      ).toBe("send");
    });
  });

  describe("loading (streaming/submitted)", () => {
    it("returns 'stop' when input is empty (preserves prior gesture)", () => {
      expect(
        computeButtonMode({
          editMode: false,
          isLoading: true,
          hasContent: false,
          hasOnQueue: true,
        }),
      ).toBe("stop");
    });

    it("returns 'queue' when there is content AND onQueue is wired", () => {
      expect(
        computeButtonMode({
          editMode: false,
          isLoading: true,
          hasContent: true,
          hasOnQueue: true,
        }),
      ).toBe("queue");
    });

    it("falls back to 'stop' when onQueue is not wired (e.g., editing)", () => {
      // This is the situation that caused the original bug: editing a
      // queued message during streaming. With editMode now overriding
      // first, this fallback only matters for callers that intentionally
      // disable queue (currently none; defensive).
      expect(
        computeButtonMode({
          editMode: false,
          isLoading: true,
          hasContent: true,
          hasOnQueue: false,
        }),
      ).toBe("stop");
    });
  });

  describe("editMode (regression: the reported bug)", () => {
    it("forces 'send' even while streaming with no onQueue", () => {
      // This is the exact branch that produced the buggy "Stop" button
      // when the user started editing a queued message during streaming.
      expect(
        computeButtonMode({
          editMode: true,
          isLoading: true,
          hasContent: true,
          hasOnQueue: false,
        }),
      ).toBe("send");
    });

    it("forces 'send' even while streaming with onQueue wired", () => {
      // Defensive: editMode + onQueue should not silently fall through
      // to "queue" semantics — Save means save.
      expect(
        computeButtonMode({
          editMode: true,
          isLoading: true,
          hasContent: true,
          hasOnQueue: true,
        }),
      ).toBe("send");
    });

    it("returns 'send' on empty input too (button is disabled by hasContent gating elsewhere)", () => {
      expect(
        computeButtonMode({
          editMode: true,
          isLoading: false,
          hasContent: false,
          hasOnQueue: false,
        }),
      ).toBe("send");
    });
  });
});
