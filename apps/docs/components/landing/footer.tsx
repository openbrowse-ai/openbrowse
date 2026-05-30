import Link from "next/link";
import { Wordmark } from "@/components/logo";

export function Footer() {
  return (
    <footer className="border-t">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-12 sm:flex-row sm:justify-between">
        <div>
          <Wordmark className="h-6" />
          <p className="mt-1 text-sm text-muted-foreground">
            The open source browser agent.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-8 text-sm sm:grid-cols-3">
          <div className="flex flex-col gap-2">
            <p className="font-medium">Docs</p>
            <Link href="/docs/basic-usage" className="text-muted-foreground hover:text-foreground">
              Basic Usage
            </Link>
            <Link href="/docs/comparison" className="text-muted-foreground hover:text-foreground">
              Comparison
            </Link>
            <Link href="/docs/agent" className="text-muted-foreground hover:text-foreground">
              Agent
            </Link>
            <Link href="/docs/models-and-providers" className="text-muted-foreground hover:text-foreground">
              Models
            </Link>
          </div>
          <div className="flex flex-col gap-2">
            <p className="font-medium">Community</p>
            <a href="https://github.com/openbrowse-ai/openbrowse" target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground">
              GitHub
            </a>
            <Link href="/changelog" className="text-muted-foreground hover:text-foreground">
              Changelog
            </Link>
            <Link href="/docs/contributing" className="text-muted-foreground hover:text-foreground">
              Contributing
            </Link>
          </div>
          <div className="flex flex-col gap-2">
            <p className="font-medium">Legal</p>
            <a href="https://github.com/openbrowse-ai/openbrowse/blob/main/LICENSE" target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground">
              MIT License
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
