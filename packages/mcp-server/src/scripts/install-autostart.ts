import { writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export async function installAutostart(): Promise<void> {
  const binary = process.execPath; // path to current node binary (or the compiled bun binary)
  const argv0 = process.argv[1] ?? ""; // path to openbrowse-mcp.mjs (or compiled entry)
  switch (platform()) {
    case "darwin":
      installLaunchAgent(binary, argv0);
      console.log("Installed launchd agent at ~/Library/LaunchAgents/com.openbrowse.mcp.plist");
      return;
    case "linux":
      installSystemdUserUnit(binary, argv0);
      console.log("Installed systemd user unit at ~/.config/systemd/user/openbrowse-mcp.service");
      return;
    case "win32":
      installTaskScheduler(binary, argv0);
      console.log("Installed Task Scheduler entry: OpenBrowseMCP");
      return;
    default:
      throw new Error(`unsupported platform for autostart: ${platform()}`);
  }
}

function logDir(): string {
  return join(homedir(), ".openbrowse");
}

function installLaunchAgent(binary: string, argv0: string): void {
  const plistDir = join(homedir(), "Library", "LaunchAgents");
  const plistPath = join(plistDir, "com.openbrowse.mcp.plist");
  mkdirSync(plistDir, { recursive: true });
  mkdirSync(logDir(), { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyLists-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.openbrowse.mcp</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binary}</string>
    <string>${argv0}</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>${join(logDir(), "mcp.log")}</string>
  <key>StandardOutPath</key><string>${join(logDir(), "mcp.log")}</string>
</dict>
</plist>
`;
  writeFileSync(plistPath, plist);
  // Unload first (idempotent), then load
  spawnSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
  const r = spawnSync("launchctl", ["load", plistPath], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`launchctl load failed (exit ${r.status})`);
}

function installSystemdUserUnit(binary: string, argv0: string): void {
  const unitDir = join(homedir(), ".config", "systemd", "user");
  mkdirSync(unitDir, { recursive: true });
  const unitPath = join(unitDir, "openbrowse-mcp.service");
  mkdirSync(logDir(), { recursive: true });
  const unit = `[Unit]
Description=OpenBrowse MCP Broker

[Service]
ExecStart=${binary} ${argv0} serve
Restart=on-failure
StandardOutput=append:${join(logDir(), "mcp.log")}
StandardError=append:${join(logDir(), "mcp.log")}

[Install]
WantedBy=default.target
`;
  writeFileSync(unitPath, unit);
  spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
  const r = spawnSync(
    "systemctl",
    ["--user", "enable", "--now", "openbrowse-mcp"],
    { stdio: "inherit" },
  );
  if (r.status !== 0) throw new Error(`systemctl enable failed (exit ${r.status})`);
}

function installTaskScheduler(binary: string, argv0: string): void {
  const tr = `${binary} ${argv0} serve`;
  const r = spawnSync(
    "schtasks",
    [
      "/Create",
      "/TN",
      "OpenBrowseMCP",
      "/SC",
      "ONLOGON",
      "/RL",
      "HIGHEST",
      "/F", // force-overwrite if exists
      "/TR",
      tr,
    ],
    { stdio: "inherit" },
  );
  if (r.status !== 0) throw new Error(`schtasks /Create failed (exit ${r.status})`);
}
