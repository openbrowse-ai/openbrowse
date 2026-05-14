import Link from "next/link";

export function Hero() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-24 md:py-32">
      <h1 className="font-mono text-4xl font-bold tracking-tight md:text-6xl">
        The open source browser agent.
      </h1>
      <p className="mt-4 max-w-2xl text-lg text-muted-foreground">
        A free, model-agnostic alternative to Claude for Chrome, Gemini in
        Chrome, and Perplexity Comet. Use any AI model — cloud or local — to
        manage, organize, and automate your browser.
      </p>
      <div className="mt-8 flex items-center gap-4">
        <a
          href="https://chromewebstore.google.com"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-10 items-center gap-2 rounded-sm bg-foreground px-6 text-sm font-medium text-background transition-opacity hover:opacity-90"
        >
          <ChromeIcon className="h-4 w-4" />
          Add to Chrome
        </a>
        <a
          href="https://github.com/openbrowse-ai/openbrowse"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-10 items-center rounded-sm border px-6 text-sm font-medium transition-colors hover:bg-muted"
        >
          GitHub
        </a>
      </div>
      <div className="mt-12 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
        <span>Free</span>
        <span className="text-border">·</span>
        <span>Open Source</span>
        <span className="text-border">·</span>
        <span>Works Offline</span>
        <span className="text-border">·</span>
        <span>BYOK or No Key</span>
      </div>
    </section>
  );
}

function ChromeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8 0-1.85.63-3.55 1.69-4.9L9.5 12l-1.64 4.5A7.96 7.96 0 0012 20zm6.31-3.1L14.5 12l1.64-4.5A7.96 7.96 0 0012 4c1.85 0 3.55.63 4.9 1.69L12 12l6.31 4.9zM12 15a3 3 0 100-6 3 3 0 000 6z" />
    </svg>
  );
}
