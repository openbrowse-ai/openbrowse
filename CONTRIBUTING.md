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

After `pnpm dev`, go to `chrome://extensions`, enable Developer Mode, and load the unpacked extension from the `.output/chrome-mv3-dev` directory.

## Project Structure

```
src/
├── entrypoints/
│   ├── background/     # Service worker — space management, messaging
│   ├── collect/        # Full-page tab organizer (collect.html)
│   ├── content/        # Content script — overlay injection, toasts
│   ├── offscreen/      # Offscreen document — AI inference (WebLLM, cloud)
│   ├── overlay/        # In-page command palette (⌘⇧K)
│   ├── settings/       # Settings page
│   └── sidepanel/      # Chrome side panel
├── components/         # Shared React components
├── hooks/              # Shared React hooks
└── lib/                # Shared utilities, types, storage
```

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
