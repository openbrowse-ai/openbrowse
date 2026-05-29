---
"openbrowse": patch
---

Add Attio as a built-in MCP connector (new "CRM" category) with OAuth, all 37 tools, and light/dark icons. Also fixes MCP reliability:

- OAuth flow now sends a `state` parameter, required by strict providers like Attio (previously failed with "Authorization page could not be loaded").
- Connected MCP servers are no longer torn down and reconnected on every home.html load — this eliminated a multi-second window where the agent saw zero MCP tools.
- An active chat conversation now rebinds to the latest transport when MCP tools finish loading, so newly connected tools become available without a refresh.
- Settings → Connectors left panel border now spans the full height.
