# Contributing to OpenBrowse

Thanks for your interest in contributing to OpenBrowse!

## Development Setup

```bash
# Clone the repo
git clone https://github.com/openbrowse-ai/openbrowse.git
cd openbrowse

# Install dependencies
pnpm install

# Start development (loads as unpacked extension in Chrome)
pnpm dev
```

After `pnpm dev`, go to `chrome://extensions`, enable Developer Mode, and load the unpacked extension from the `apps/extension/.output/chrome-mv3-dev` directory.

## Project Structure

OpenBrowse is a pnpm monorepo:

```
apps/
├── extension/          # WXT Chrome extension (the OpenBrowse browser agent)
│   └── src/
│       ├── entrypoints/
│       │   ├── background/   # Service worker — space management, messaging
│       │   ├── content/      # Content script — overlay injection, toasts
│       │   ├── home/         # Full-page home/tab organizer
│       │   ├── offscreen/    # Offscreen document — AI inference (WebLLM, cloud)
│       │   ├── overlay/      # In-page command palette (Alt+K)
│       │   ├── settings/     # Settings page
│       │   └── sidepanel/    # Chrome side panel
│       ├── components/       # React components
│       ├── hooks/            # React hooks
│       ├── lib/              # Utilities, agent loop, MCP client, skills, OPFS
│       └── registry/
│           └── providers/    # LLM provider definitions (factories + metadata)
└── docs/               # Next.js + Fumadocs documentation site

packages/
└── connectors/         # @openbrowse/connectors — MCP connector registry
                        # (shared between extension and docs)
```

Common scripts (run from repo root):

- `pnpm dev` — run the extension in dev mode (Chrome)
- `pnpm dev:firefox` — run the extension in dev mode (Firefox)
- `pnpm dev:docs` — run the docs site
- `pnpm build` — build everything
- `pnpm compile` — typecheck every workspace

## Tech Stack

- [WXT](https://wxt.dev/) — Chrome extension framework
- [React 19](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/)
- [Tailwind CSS v4](https://tailwindcss.com/)
- [Vercel AI SDK](https://sdk.vercel.ai/) — multi-provider LLM support
- [WebLLM](https://webllm.mlc.ai/) — local model inference via WebGPU
- [shadcn/ui](https://ui.shadcn.com/) — component primitives

## Making Changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Test the extension locally with `pnpm dev`
4. Run `pnpm compile` to check for type errors
5. Open a pull request

## Code Style

- TypeScript strict mode
- No comments unless the "why" is non-obvious
- Prefer editing existing files over creating new ones

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
