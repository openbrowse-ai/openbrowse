import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../constants";

describe("DEFAULT_SETTINGS tab-cleanup defaults", () => {
  it("auto-close is off by default", () => {
    expect(DEFAULT_SETTINGS.autoCloseCompletedAgentTabs).toBe(false);
  });
  it("auto-close timeout defaults to 30 minutes", () => {
    expect(DEFAULT_SETTINGS.autoCloseCompletedAgentTabsAfterMinutes).toBe(30);
  });
});
