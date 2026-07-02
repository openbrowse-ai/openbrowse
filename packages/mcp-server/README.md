# @openbrowse/mcp-server

Local OAuth 2.1 + WebSocket broker that lets external MCP hosts (Cursor,
Claude Desktop, OpenCode, Continue, and anything else speaking the [Model
Context Protocol](https://modelcontextprotocol.io/)) drive the
[OpenBrowse](https://github.com/openbrowse-ai/openbrowse) browser
extension.

The broker runs on your machine, binds to `127.0.0.1`, and never phones
home. Hosts authorise via a browser-based OAuth flow with mandatory
PKCE-S256; every RPC is scoped and audited.

Read [`docs/threat-model.md`](https://github.com/openbrowse-ai/openbrowse/blob/main/docs/threat-model.md)
before installing to understand what the bridge exposes.

## Install

### Homebrew (macOS)

```sh
brew install openbrowse-ai/tap/openbrowse-mcp
```

### npm / npx (any Node platform)

Run once (no global install):

```sh
npx -y @openbrowse/mcp-server
```

Install globally so `openbrowse-mcp` is on your `PATH`:

```sh
npm install -g @openbrowse/mcp-server
```

### GitHub Releases

Precompiled binary downloads are not yet published — use Homebrew or npm.

## First run

```sh
openbrowse-mcp
```

Output:

```text
OpenBrowse MCP broker ready on http://127.0.0.1:47821
Key fingerprint: 0123456789abcdef
```

The broker holds the port until you `Ctrl+C` or the process dies. Point
your MCP host at `http://127.0.0.1:47821/mcp` and authorise it via the
browser popup the extension opens.

For autostart on boot:

```sh
openbrowse-mcp install
```

Installs a launchd agent (macOS), systemd user unit (Linux), or Task
Scheduler task (Windows). Remove with `openbrowse-mcp uninstall`.

## Commands

| Command | What it does |
|---|---|
| `openbrowse-mcp` / `openbrowse-mcp serve` | Start the broker in the foreground. |
| `openbrowse-mcp install` | Register autostart for the current user. |
| `openbrowse-mcp uninstall` | Remove autostart. |
| `openbrowse-mcp --rotate-keys` | Back up the current broker keypair and generate a new one. Re-TOFU the extension after running. |
| `openbrowse-mcp --version` | Print version. |
| `openbrowse-mcp --help` | Print this help. |

## Configuration

The broker reads its state from `~/.openbrowse/`:

| File | Purpose |
|---|---|
| `broker-key.json` | EdDSA keypair used to sign JWTs and to negotiate the extension WS handshake (TOFU). |
| `broker.lock` | PID lock preventing a second broker from binding the same port. |
| `refresh-tokens.json` | Per-host refresh tokens (rotated on every use, 30-day idle expiry). |

Everything else lives in the extension's own storage (per-host policy,
audit log, etc.). Uninstalling the broker leaves the extension's state
intact.

## Uninstall

```sh
openbrowse-mcp uninstall        # remove autostart
brew uninstall openbrowse-mcp   # macOS Homebrew
npm uninstall -g @openbrowse/mcp-server   # npm
```

Then delete `~/.openbrowse/` to reset broker state.

## Documentation

- Full deployment guide: [`docs/deployment.md`](https://github.com/openbrowse-ai/openbrowse/blob/main/docs/deployment.md)
- Threat model: [`docs/threat-model.md`](https://github.com/openbrowse-ai/openbrowse/blob/main/docs/threat-model.md)
- OpenBrowse repo: <https://github.com/openbrowse-ai/openbrowse>

## License

MIT — see [LICENSE](./LICENSE).
