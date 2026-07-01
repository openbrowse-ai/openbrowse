import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Stub child_process so we don't actually invoke launchctl/systemctl/schtasks.
vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => ({ status: 0 })),
}));

describe("install-autostart", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "obx-autostart-"));
  });
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
    vi.doUnmock("node:os");
  });

  it("writes a launchd plist on darwin and invokes launchctl load", async () => {
    const home = tmpHome;
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, platform: () => "darwin", homedir: () => home };
    });
    const { installAutostart } = await import("../install-autostart");
    await installAutostart();
    const plistPath = join(tmpHome, "Library", "LaunchAgents", "com.openbrowse.mcp.plist");
    expect(existsSync(plistPath)).toBe(true);
    const plist = readFileSync(plistPath, "utf8");
    expect(plist).toContain("<key>Label</key><string>com.openbrowse.mcp</string>");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    const { spawnSync } = await import("node:child_process");
    expect(spawnSync).toHaveBeenCalledWith(
      "launchctl",
      expect.arrayContaining(["load", plistPath]),
      expect.anything(),
    );
  });

  it("writes a systemd unit on linux and invokes systemctl enable", async () => {
    const home = tmpHome;
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, platform: () => "linux", homedir: () => home };
    });
    const { installAutostart } = await import("../install-autostart");
    await installAutostart();
    const unitPath = join(tmpHome, ".config", "systemd", "user", "openbrowse-mcp.service");
    expect(existsSync(unitPath)).toBe(true);
    const unit = readFileSync(unitPath, "utf8");
    expect(unit).toContain("Description=OpenBrowse MCP Broker");
    expect(unit).toContain("WantedBy=default.target");
    const { spawnSync } = await import("node:child_process");
    expect(spawnSync).toHaveBeenCalledWith(
      "systemctl",
      expect.arrayContaining(["enable", "--now", "openbrowse-mcp"]),
      expect.anything(),
    );
  });

  it("invokes schtasks /Create on win32", async () => {
    const home = tmpHome;
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, platform: () => "win32", homedir: () => home };
    });
    const { installAutostart } = await import("../install-autostart");
    await installAutostart();
    const { spawnSync } = await import("node:child_process");
    expect(spawnSync).toHaveBeenCalledWith(
      "schtasks",
      expect.arrayContaining(["/Create", "/TN", "OpenBrowseMCP"]),
      expect.anything(),
    );
  });
});
