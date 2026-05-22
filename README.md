<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/docs/public/icon/wordmark-dark.svg">
    <img src="apps/docs/public/icon/wordmark.svg" alt="OpenBrowse" width="400">
  </picture>
</p>

<p align="center"><strong>The open source browser agent.</strong></p>

<p align="center">A free, model-agnostic alternative to Claude for Chrome, Gemini in Chrome, and Perplexity Comet. Use any AI model — cloud or local — to manage, organize, and automate your browser.</p>

## Features

- **Agent side panel** — Chat with an AI agent that reads pages, clicks elements, navigates, runs JavaScript / Python, and writes files in a per-conversation OPFS workspace
- **Skills** — Curated, on-demand instructions the agent loads when relevant; implements the [agentskills.io](https://agentskills.io) standard
- **MCP connectors** — GitHub, Linear, Slack, Notion, Sentry, Vercel, Stripe, Supabase
- **Spaces** — Window-based tab organization with per-space color themes
- **AI Tidy** — Semantic tab grouping and title cleanup
- **Overlay** — Global command palette for tab search and quick actions (`Alt+K`)
- **Detachable side panel** — Pop the chat out into a floating window, or trigger a Gemini-style global popup with `Alt+Space`
- **Model-agnostic** — 130+ providers via the live [models.dev](https://models.dev) catalog: OpenAI, Anthropic, Google, xAI, Mistral, OpenRouter, Groq, Together, local models via WebLLM / Ollama, or Chrome's built-in Gemini Nano
- **BYOK** — Bring your own API key, or run entirely local with no key needed

## Install

OpenBrowse is launching on the Chrome Web Store soon. While the listing
is being approved, you can install the latest build manually in about
30 seconds.

### Manual install (recommended)

1. Download `openbrowse-<version>-chrome.zip` from the latest [GitHub Release](https://github.com/openbrowse-ai/openbrowse/releases/latest).
2. Unzip it.
3. Open `chrome://extensions`, toggle **Developer mode** on, and click **Load unpacked**. Select the unzipped folder.

When the Chrome Web Store version goes live, your conversations, API keys, MCP connectors, and OPFS workspaces will carry over automatically — both installs share the same extension ID.

Full instructions in the [docs](https://openbrowse.ai/docs/overview#manual-install-current).

### From source (developers)

```bash
git clone https://github.com/openbrowse-ai/openbrowse.git
cd openbrowse
pnpm install
pnpm dev
```

Then go to `chrome://extensions`, enable Developer Mode, and load the `apps/extension/.output/chrome-mv3-dev` directory.

## Architecture

OpenBrowse is a pnpm monorepo. The Chrome extension (`apps/extension`) is built with [WXT](https://wxt.dev/), React, and the [Vercel AI SDK](https://ai-sdk.dev/).

```
apps/
├── extension/          # The OpenBrowse Chrome extension
│   └── src/
│       ├── entrypoints/
│       │   ├── background/   # Service worker
│       │   ├── content/      # Overlay injection
│       │   ├── home/         # Full-page home / tab organizer
│       │   ├── offscreen/    # AI inference (WebLLM, cloud APIs, Pyodide)
│       │   ├── overlay/      # Command palette (Alt+K)
│       │   ├── settings/     # Settings page
│       │   └── sidepanel/    # Chrome side panel — agent chat
│       ├── components/
│       ├── hooks/
│       ├── lib/
│       │   ├── agent/        # Agent transport, tools, memory, compaction
│       │   ├── python/       # Pyodide message protocol
│       │   └── vfs/          # OPFS abstraction (per-conversation workspaces)
│       └── registry/
│           ├── models-dev/   # Vendored models.dev snapshot + refresh logic
│           └── providers/    # Static provider entries
└── docs/               # Documentation site (Next.js + Fumadocs)

packages/
└── connectors/         # @openbrowse/connectors — MCP connector registry
```

## AI Providers

OpenBrowse picks from the live [models.dev](https://models.dev) catalog (130+ providers, 4,800+ models). Curated setup guides for the most common ones:

| Provider                                 | Setup                      | Runs Locally |
| ---------------------------------------- | -------------------------- | :----------: |
| Chrome Built-in AI (Gemini Nano)         | No setup needed            |     Yes      |
| WebLLM (Llama, Phi, etc.)                | Download model in settings |     Yes      |
| Ollama                                   | Local Ollama server        |     Yes      |
| OpenAI                                   | API key                    |      No      |
| Anthropic                                | API key                    |      No      |
| Google Gemini                            | API key                    |      No      |
| OpenAI-Compatible (Groq, Together, etc.) | API key + base URL         |      No      |

See [docs/models-and-providers](https://openbrowse.ai/docs/models-and-providers) for the full list.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
