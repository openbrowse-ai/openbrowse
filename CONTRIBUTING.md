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
│       ├── lib/              # Utilities, agent loop, MCP client, skills, OPFS / VFS
│       └── registry/
│           ├── models-dev/   # Vendored models.dev snapshot + refresh logic
│           └── providers/    # Static provider entries (browser-ai, web-llm, openai-compatible)
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
- `pnpm test` — run the extension's vitest suite
- `pnpm zip` — package the extension as a release zip
- `pnpm refresh:models` — refresh the bundled `models.dev` snapshot
- `pnpm changeset` — record a release note for the next version

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
5. Run `pnpm test` to make sure tests pass
6. If your PR changes user-facing behavior, run `pnpm changeset` and commit the generated `.changeset/*.md` file (see [`.changeset/README.md`](.changeset/README.md))
7. Open a pull request — every PR gets an installable extension build attached as an artifact, posted as a comment

## Code Style

- TypeScript strict mode
- No comments unless the "why" is non-obvious
- Prefer editing existing files over creating new ones

## Reporting Bugs and Requesting Features

Use the [issue templates](https://github.com/openbrowse-ai/openbrowse/issues/new/choose). Questions and general discussion belong in our [Discord](https://discord.gg/v47UJ27TTa). Security vulnerabilities should be reported privately — see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
