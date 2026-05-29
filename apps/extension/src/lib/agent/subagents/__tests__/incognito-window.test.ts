import { describe, expect, it, vi } from "vitest";
import {
  closeIncognitoWindow,
  openIncognitoWindow,
  type WindowsAPI,
} from "../incognito-window";

const fakeWindowsAPI = (
  overrides: Partial<WindowsAPI> = {},
): WindowsAPI => ({
  create: vi.fn(async () => ({ id: 999 })),
  remove: vi.fn(async () => {}),
  ...overrides,
});

describe("openIncognitoWindow", () => {
  it("creates an incognito window and returns its id", async () => {
    const api = fakeWindowsAPI();
    const out = await openIncognitoWindow(api);
    expect(out.windowId).toBe(999);
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({ incognito: true }),
    );
  });

  it("throws when the windows API returns a window with no id", async () => {
    const api = fakeWindowsAPI({ create: vi.fn(async () => ({})) });
    await expect(openIncognitoWindow(api)).rejects.toThrow(/no.*id/i);
  });

  it("throws when incognito creation is blocked by policy", async () => {
    const api = fakeWindowsAPI({
      create: vi.fn().mockRejectedValue(new Error("incognito blocked by policy")),
    });
    await expect(openIncognitoWindow(api)).rejects.toThrow(/blocked by policy/i);
  });
});

describe("closeIncognitoWindow", () => {
  it("calls remove with the supplied window id", async () => {
    const api = fakeWindowsAPI();
    await closeIncognitoWindow(api, 12);
    expect(api.remove).toHaveBeenCalledWith(12);
  });

  it("swallows errors from remove (idempotent close)", async () => {
    const api = fakeWindowsAPI({
      remove: vi.fn(async () => {
        throw new Error("No window with id: 12");
      }),
    });
    // Must not reject.
    await expect(closeIncognitoWindow(api, 12)).resolves.toBeUndefined();
  });
});
