# OpenBrowse MCP Bridge — Threat Model

This document explains the trust boundaries, capabilities, and adversaries
that the OpenBrowse MCP bridge is designed against. It's written for end
users deciding whether to run the bridge, and for security reviewers
auditing its design. Read this before installing.

The MCP bridge lets MCP-speaking applications (Claude Desktop, Cursor,
custom agents) drive your real browser. That is powerful — and the same
power can be abused. The sections below describe exactly what the bridge
can and can't do, and what assumptions it makes about its environment.

## 1. What the bridge CAN do

When connected, an authorized MCP host can:

- **Read every page in your logged-in browser sessions.** This includes
  Gmail, GitHub, your bank, internal company tools, social DMs — anywhere
  your browser is signed in. The host sees what you see.
- **Drive the browser.** Click buttons, type into forms, submit forms,
  scroll, navigate, take screenshots.
- **Open new tabs/URLs.** Including authenticated URLs in your current
  profile.
- **Run agentic tasks.** The `task` tool spawns a tool-using agent inside
  the browser that can chain multiple of the above operations.

The bridge gives the host the same surface area as a human sitting at
your keyboard — minus the ability to bypass per-task consent prompts
when configured to require them.

## 2. What the bridge CANNOT do

The bridge cannot:

- **Open new browser profiles.** It works in the Chrome profile that has
  OpenBrowse installed, full stop.
- **Log into accounts you haven't logged into yourself.** It has no
  password manager, no SSO impersonation, no credential injection.
- **Escape Chrome's sandbox.** It runs as an extension; Chrome's
  multi-process security model applies. Site isolation, same-origin
  policy, and CSP all still apply to the content scripts it injects.
- **Reach the network beyond loopback.** The broker listens on
  `127.0.0.1:47821`. Browser security model also blocks Chrome's public
  origins from reaching localhost without explicit user action.
- **Access your file system.** No file I/O outside `~/.openbrowse/`
  (broker state) and `chrome.storage.local` (extension state).
- **Run on machines you didn't install it on.** No autostart on first
  install — opt-in via `openbrowse-mcp install`.

## 3. Trust model

The bridge enforces a three-tier consent model:

### 3.1 Per-host JWT

Each MCP host registers via OAuth 2.1 Dynamic Client Registration (RFC
7591) and receives its own `client_id`. Every request carries a
short-lived JWT (24h) tied to that client. Tokens are not shareable
between hosts — revoking one host doesn't affect any other.

### 3.2 Per-host policy

In the extension settings (Settings → MCP Bridge → Hosts), each host has
one of three policies:

- **Always prompt** (default) — every task requires a per-task user
  confirmation dialog.
- **Auto-allow** — host's RPC calls run without prompting. Use this only
  for hosts you've verified and trust deeply.
- **Blocked** — all calls are denied at the broker. Tokens for blocked
  hosts get revoked immediately on policy change.

### 3.3 Per-task confirmation

When a host is in "always prompt" mode, calls that perform actions (vs
read-only) trigger a system notification with the host name, tool name,
and a brief summary of args. The user clicks Allow or Deny.

- **60-second auto-deny.** If the user doesn't respond within 60 seconds,
  the request is denied automatically — agents can't sit and wait forever.
- **Per-task scope.** Each call gets its own prompt; granting one doesn't
  silently grant the next.

### 3.4 Revocation

The user can revoke any host's access at any time from the settings UI.
Revocation immediately:

1. Deletes the host's refresh tokens (forcing fresh consent on next call).
2. Flips the host's policy to "blocked".
3. Closes any in-flight WebSocket sessions for that host.

## 4. Network exposure

```
MCP host ──HTTP──▶ 127.0.0.1:47821 (broker) ──WS──▶ extension (Chrome)
                   │
                   └── refuses any non-loopback source IP
```

- **Broker bind address:** `127.0.0.1` (loopback only). Never `0.0.0.0`.
- **Port:** 47821 by default. Configurable; never auto-selects a public
  interface.
- **No TLS on loopback.** Connections between MCP host and broker are
  plain HTTP because they don't leave the machine. The Ed25519 broker
  identity is verified out-of-band via fingerprint pinning (TOFU) in the
  extension.
- **No exposure unless you tunnel it.** If you SSH-forward or `ngrok` the
  port, you've opted into Internet exposure — the bridge does not.

## 5. Adversaries considered

### 5.1 Malicious local app (same user account)

**Capability.** Any process on your machine can reach `127.0.0.1:47821`.
This is the most realistic attacker.

**What they can attempt.**

- `POST /register` to get a `client_id`. This succeeds — DCR is open by
  design.
- `POST /authorize` to start an OAuth flow. This redirects to the
  user-facing consent page.

**What stops them.**

- **No silent token issuance.** Every token requires user click-through.
  An attacker who gets to `/authorize` cannot complete the flow without
  the human at the keyboard approving it.
- **Per-task consent dialogs** for any host in "always prompt" mode.
  Even an attacker with a valid JWT can't act invisibly.
- **60-second auto-deny.** The attacker can't queue requests hoping the
  user will absent-mindedly approve them later.
- **Audit log.** Every call, allowed or denied, lands in the audit log
  (Settings → MCP Bridge → Audit). The user can spot a host they don't
  recognize.

### 5.2 Hostile MCP host (registered legitimately but adversarial)

**Capability.** A host the user installed in good faith but that turns
out to misbehave. For example, a third-party MCP plugin that escalates
beyond its stated scope.

**What stops them.**

- **Per-task confirmation** is the primary defense — the user sees each
  destructive call before it runs.
- **Audit log** reveals unusual call patterns (e.g. a translation tool
  calling `read_page` on banking URLs).
- **One-click revocation** in settings.
- **Client name pinning (Phase 5):** A re-registered `client_id` that
  changes its `client_name` will be flagged. This is not yet enforced
  in Phase 4.

### 5.3 Compromised website (running in your browser)

**Capability.** A malicious page is loaded in a tab. The page wants to
reach the broker to escalate from "tab-scoped JS" to "browser-scoped
agent".

**What stops them.**

- **Chrome blocks `fetch("http://localhost:47821/")`** from public
  origins by default in recent Chrome versions (Private Network Access).
- **CORS allow-list** on the broker rejects requests whose `Origin` is
  not the OpenBrowse extension or loopback.
- **No JS sandbox escape.** A compromised page cannot reach the
  extension's service worker except through chrome.runtime
  messaging, which the extension does not expose to web pages.

### 5.4 Stolen `~/.openbrowse/` directory

**Capability.** An attacker copies your `~/.openbrowse/` (e.g. via
unattended workstation, backup leak).

**What they get.**

- The broker's private signing key (`broker-key.json`).
- Issued refresh tokens.
- The audit log.

**What stops them.**

- **The key is useless on another machine** — it signs JWTs the
  extension on YOUR machine accepts. The extension on the attacker's
  machine would TOFU a different key.
- **The attacker still needs the user's consent** for each task if
  policies are "always prompt".

If you suspect this happened, run `openbrowse-mcp --rotate-keys` and
re-TOFU in the extension.

### 5.5 Phishing the TOFU prompt

**Capability.** An attacker hopes the user clicks "Trust" on a broker
they don't actually want to trust.

**What stops them.**

- **Fingerprint visibility.** The TOFU prompt shows the broker's key
  fingerprint and the binary's SHA-256. The user can compare these
  against the values printed by `openbrowse-mcp` in their terminal.
- **`processInfo` visibility.** The prompt shows the broker's pid and
  executable path. A user paying attention can spot `/tmp/evil/openbrowse-mcp`.
- **Single-trust model.** Once pinned, any second broker process is
  rejected (key mismatch surfaces as a warning, not silent acceptance).

## 6. Key rotation

`openbrowse-mcp --rotate-keys`:

1. Backs the current key up to `~/.openbrowse/broker-key.previous.json`.
2. Generates a fresh Ed25519 keypair.
3. **Invalidates every existing host's JWTs.** All MCP hosts must
   re-authorize through the consent flow.
4. **Invalidates the extension's pinned fingerprint.** The extension
   shows a key-mismatch warning; the user clicks Trust again after
   verifying the new fingerprint.

When to rotate:

- After suspected key exposure (lost laptop, leaked backup).
- After a host you no longer trust had broad token access.
- Periodically (annually-ish) if you're cautious.

You can keep `broker-key.previous.json` for forensics or delete it.

## 7. What to monitor

The extension's Settings → MCP Bridge surfaces:

- **Audit log.** Per-host call count, methods invoked, outcomes. Anomalous
  patterns (e.g. a host you forgot about calling `read_page` 200 times
  yesterday) are visible here.
- **Active hosts.** Currently registered `client_id`s with their last-seen
  timestamps.
- **Token health.** When tokens expire, when refresh tokens were last used.

If your threat model is high (regulated industry, sensitive intellectual
property), set every host to "always prompt" and review the audit log
weekly.

## 8. Out of scope

The MCP bridge is NOT designed to defend against:

- **Root-level compromise of your machine.** A privileged attacker can
  read browser memory, inject code into the extension, or replace the
  broker binary. The bridge's threat model assumes user-level isolation
  is intact.
- **Browser zero-days.** If Chrome itself is compromised, all bets are off.
- **Hardware key extraction.** No HSM/TEE binding. The signing key lives
  in a file in your home directory.

For these threats, layer additional controls (full-disk encryption, OS
integrity protection, regulated build channel).

## 9. Reporting issues

Security issues: open a private security advisory on the OpenBrowse
GitHub repository. Do not post details to public issues.
