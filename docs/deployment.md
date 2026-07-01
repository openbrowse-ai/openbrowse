# OpenBrowse MCP Bridge — Deployment Guide

How to install, configure, autostart, and uninstall the OpenBrowse MCP
bridge. Aimed at end users running it on a single workstation and at
power users who want it to come up on every boot.

Before installing, read `threat-model.md` to understand what the bridge
exposes.

## 1. Install paths

Pick one. They install the same binary to different locations.

### 1.1 Homebrew (macOS)

```sh
brew install openbrowse-ai/tap/openbrowse-mcp
```

Installs to `/opt/homebrew/bin/openbrowse-mcp` (Apple Silicon) or
`/usr/local/bin/openbrowse-mcp` (Intel). Requires Homebrew's `node`
formula as a runtime dependency.

### 1.2 winget (Windows)

Not yet available. Windows users should use the npm / npx path below.

### 1.3 npm / npx (cross-platform)

```sh
npx -y @openbrowse/mcp-server
```

Runs without installing globally. To make it persistent:

```sh
npm install -g @openbrowse/mcp-server
```

Useful for trying it out, or for Node-heavy dev environments where you
already have a global `node`/`npm`. Both invocations expose the same
`openbrowse-mcp` command.

### 1.4 GitHub Releases binary

Precompiled standalone binaries are not yet published. Use Homebrew or
npm above.

## 2. First-run setup

A clean first-run looks like this:

### 2.1 Start the broker

```sh
openbrowse-mcp
```

Output:

```
OpenBrowse MCP broker ready on http://127.0.0.1:47821
Key fingerprint: 0123456789abcdef
```

**Copy that fingerprint.** You'll compare it against what the extension
shows in step 2.3.

### 2.2 Install the OpenBrowse extension

Install from the Chrome Web Store, then open the extension's Settings →
MCP Bridge page. You'll see a "Broker not trusted" banner.

### 2.3 TOFU: trust the broker

Click "Trust" in the extension UI. A dialog displays:

- **Fingerprint:** must match what the broker terminal printed in 2.1.
- **Binary SHA-256:** the SHA-256 of the broker binary you're running.
- **Process info:** pid, path to executable.

Verify the fingerprint matches. If it does, click "Confirm trust".
The extension pins this fingerprint for all future reconnects.

### 2.4 Add the broker URL to your MCP host

Each MCP host configures it slightly differently. Examples:

**Claude Desktop** — `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "openbrowse": {
      "url": "http://localhost:47821/mcp"
    }
  }
}
```

**Cursor** — Settings → MCP Servers → Add:

```
http://localhost:47821/mcp
```

**Custom host (anything speaking MCP):** point it at
`http://localhost:47821/mcp`.

### 2.5 Authorize the host

On the host's first tool call, the broker redirects to a consent page in
your default browser. The page shows:

- Which host is asking (name + version).
- Which tools it wants access to.
- The OAuth `client_id` and `redirect_uri` (must be `localhost:*`).

Click **Allow**. The host receives an access token and proceeds with the
call. Future calls reuse the token until it expires (24h).

## 3. Autostart

To have the broker come up on every boot:

```sh
openbrowse-mcp install
```

This writes a per-user autostart entry:

- **macOS:** `~/Library/LaunchAgents/com.openbrowse.mcp.plist` (launchd).
- **Linux:** `~/.config/systemd/user/openbrowse-mcp.service` (systemd).
- **Windows:** Task Scheduler entry under your user account.

Reboot, then verify:

```sh
curl http://127.0.0.1:47821/
```

You should get a small JSON response with version + fingerprint.

To remove:

```sh
openbrowse-mcp uninstall
```

This removes the autostart entry but leaves `~/.openbrowse/` (state, keys,
audit log) intact.

## 4. Multi-host setup

Each MCP host registers independently via OAuth Dynamic Client
Registration. There is no single "API key" to share. You can run:

- Claude Desktop
- Cursor
- A custom CLI agent
- Three different ChatGPT plugins (if/when they support MCP HTTP)

…all simultaneously, each with its own consent flow, JWT, and audit
trail. The extension's Settings → MCP Bridge → Hosts lists every
registered host with controls to:

- Change its policy (`always-prompt` / `auto-allow` / `blocked`).
- View its audit log.
- Revoke its access.

## 5. Uninstall (clean removal)

```sh
# Remove autostart
openbrowse-mcp uninstall

# Remove the binary
brew uninstall openbrowse-mcp                # macOS Homebrew
# or
npm uninstall -g @openbrowse/mcp-server      # npm

# Wipe local state (keys, tokens, audit log)
rm -rf ~/.openbrowse/                # macOS / Linux
# Windows:
# rmdir /S "%USERPROFILE%\.openbrowse"

# Remove the extension
# (Chrome Extensions page → Remove)
```

After this, no trace of the bridge remains except whatever individual
MCP host configs you added in step 2.4. Remove those manually.

## 6. Troubleshooting

### "Address already in use" / port 47821 stale

Another process holds the port:

```sh
# macOS / Linux:
lsof -i :47821
# Windows:
netstat -ano | findstr 47821
```

If it's a stale `openbrowse-mcp` process, kill it. If the broker's lock
file (`~/.openbrowse/broker.lock`) refers to a dead pid, the next
`openbrowse-mcp` startup notices and overwrites it automatically.

### Extension shows "Broker key mismatch"

The fingerprint the extension pinned no longer matches what the broker
is serving. Causes:

1. You ran `openbrowse-mcp --rotate-keys`. Re-TOFU in Settings → MCP
   Bridge.
2. Someone replaced your broker binary (or `~/.openbrowse/broker-key.json`).
   Investigate before re-TOFUing.
3. You're running a second broker on a different host that's hijacked
   the port. Check `lsof` / `netstat`.

### "Binary drift warning" (advisory)

The broker is running but its binary has a different SHA-256 than at
last connect. Almost always benign — you upgraded the broker. Confirm
the new binary is the one you intended (release page → `sha256sum`).

If it isn't, run `openbrowse-mcp --rotate-keys` and investigate.

### MCP host gets 401 on every call

The access token expired or the host's registration was revoked. Most
hosts auto-refresh through the OAuth refresh flow; if your host doesn't,
re-add the broker URL in the host's config or click Reauthorize in the
host UI.

### Per-task confirmation prompts never show

System notifications may be blocked at the OS level. Check:

- macOS: System Settings → Notifications → Chrome / OpenBrowse → Allow.
- Windows: Settings → Notifications & actions → Chrome → On.
- Linux: ensure a notification daemon (e.g. `mako`, `dunst`) is running.

Alternatively the extension's policy is set to "auto-allow" — change it
back to "always prompt" in Settings → MCP Bridge → Hosts.

## 7. Logs

Default log file: `~/.openbrowse/mcp.log`.

Rotates at 10 MB; keeps two backups. Useful for:

- Confirming startup succeeded.
- Tracing per-request flow when a host call mysteriously fails.
- Auditing past activity outside the extension's audit log view.

Tail it live:

```sh
tail -f ~/.openbrowse/mcp.log
```

Sensitive data — JWT contents, page bodies, screenshot bytes — is NOT
written to this log. Only structural events (RPC method names, timing,
outcomes).

## 8. Configuration

Defaults are intentional and minimal. To override, set environment
variables before launching:

| Variable                      | Default              | Purpose                                  |
|-------------------------------|----------------------|------------------------------------------|
| `OPENBROWSE_MCP_PORT`         | `47821`              | Broker bind port.                        |
| `OPENBROWSE_MCP_HOST`         | `127.0.0.1`          | Broker bind address. **Loopback only.**  |
| `OPENBROWSE_MCP_LOG_LEVEL`    | `info`               | `debug` / `info` / `warn` / `error`.     |
| `OPENBROWSE_MCP_TOKEN_TTL`    | `86400` (24h)        | Access-token lifetime in seconds.        |
| `OPENBROWSE_HOME`             | `~/.openbrowse`      | State directory.                         |

Do NOT set `OPENBROWSE_MCP_HOST` to a non-loopback address unless you've
read `threat-model.md` § 4 and understand what you're exposing.

## 9. Updating

```sh
brew upgrade openbrowse-mcp
# or
npm update -g @openbrowse/mcp-server
```

After upgrade, the extension may surface a "binary drift" advisory the
next time the broker reconnects. Confirm the new binary is the one you
intended; no action needed beyond acknowledging the notice.
