import { existsSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export async function uninstallAutostart(): Promise<void> {
  switch (platform()) {
    case "darwin": {
      const plistPath = join(
        homedir(),
        "Library",
        "LaunchAgents",
        "com.openbrowse.mcp.plist",
      );
      if (existsSync(plistPath)) {
        spawnSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
        unlinkSync(plistPath);
        console.log(`Removed ${plistPath}`);
      } else {
        console.log("No launchd agent found.");
      }
      return;
    }
    case "linux": {
      const unitPath = join(
        homedir(),
        ".config",
        "systemd",
        "user",
        "openbrowse-mcp.service",
      );
      if (existsSync(unitPath)) {
        spawnSync("systemctl", ["--user", "disable", "--now", "openbrowse-mcp"], {
          stdio: "ignore",
        });
        unlinkSync(unitPath);
        spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
        console.log(`Removed ${unitPath}`);
      } else {
        console.log("No systemd user unit found.");
      }
      return;
    }
    case "win32": {
      const r = spawnSync(
        "schtasks",
        ["/Delete", "/TN", "OpenBrowseMCP", "/F"],
        { stdio: "inherit" },
      );
      if (r.status === 0) console.log("Removed OpenBrowseMCP scheduled task.");
      else console.log("No scheduled task found.");
      return;
    }
    default:
      throw new Error(`unsupported platform: ${platform()}`);
  }
}
