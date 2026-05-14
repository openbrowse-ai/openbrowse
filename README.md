# OpenBrowse

**The open source browser agent.**

A free, model-agnostic alternative to Claude for Chrome, Gemini in Chrome, and Perplexity Comet. Use any AI model — cloud or local — to manage, organize, and automate your browser.

## Features

- **Spaces** — Window-based tab organization with per-space color themes
- **AI Tidy** — Semantic tab grouping and title cleanup powered by AI
- **Auto-Tidy** — Scheduled background tab cleanup
- **Overlay** — Global command palette for tab search and quick actions (⌘⇧K)
- **Favorites** — Pin tabs that persist across sessions
- **History Search** — Recently closed tabs, instantly restorable
- **Model-Agnostic** — Works with any provider: OpenAI, Anthropic, Google, local models via WebLLM, or Chrome's built-in Gemini Nano
- **BYOK** — Bring your own API key, or run entirely local with no API key needed

## Install

> OpenBrowse is in active development. Chrome Web Store listing coming soon.

### From Source

```bash
git clone https://github.com/openbrowse-ai/openbrowse.git
cd openbrowse
pnpm install
pnpm dev
```

Then go to `chrome://extensions`, enable Developer Mode, and load the `.output/chrome-mv3-dev` directory.

## Architecture

OpenBrowse is a Chrome extension built with [WXT](https://wxt.dev/), React, and the [Vercel AI SDK](https://sdk.vercel.ai/).

```
src/
├── entrypoints/
│   ├── background/     # Service worker
│   ├── collect/        # Full-page tab organizer
│   ├── content/        # Overlay injection
│   ├── offscreen/      # AI inference (WebLLM, cloud APIs)
│   ├── overlay/        # Command palette (⌘⇧K)
│   ├── settings/       # Settings page
│   └── sidepanel/      # Chrome side panel
├── components/         # Shared UI components
├── hooks/              # Shared React hooks
└── lib/                # Utilities, types, storage
```

## AI Providers

| Provider                                 | Setup                      | Runs Locally |
| ---------------------------------------- | -------------------------- | :----------: |
| Chrome Built-in AI (Gemini Nano)         | No setup needed            |     Yes      |
| WebLLM (Llama, Phi, etc.)                | Download model in settings |     Yes      |
| OpenAI                                   | API key                    |      No      |
| Anthropic                                | API key                    |      No      |
| Gemini                                   | API key                    |      No      |
| OpenAI-Compatible (Groq, Together, etc.) | API key + base URL         |      No      |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
