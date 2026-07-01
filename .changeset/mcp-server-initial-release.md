---
"@openbrowse/mcp-server": minor
---

Initial public release of the OpenBrowse MCP broker.

The broker is a local OAuth 2.1 + WebSocket bridge that lets external
MCP hosts (Cursor, Claude Desktop, OpenCode, Continue, etc.) drive the
OpenBrowse browser extension. It ships as an npm package
(`@openbrowse/mcp-server`, invoked as `openbrowse-mcp`) and a Homebrew
formula (`openbrowse-ai/tap/openbrowse-mcp`).

Full feature set was landed in PR #176 (feat(mcp): OpenBrowse MCP
subagent bridge, Phases 1-4); this changeset publishes the artefact.
