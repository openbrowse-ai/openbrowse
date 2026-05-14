import { Terminal } from "lucide-react";

interface Props {
  args: Record<string, unknown>;
  result: unknown;
}

export function CodeResult({ args, result }: Props) {
  const code = typeof args.code === "string" ? args.code : "";
  const resultObj = result as { result?: unknown; logs?: string[]; error?: string } | undefined;

  return (
    <div className="ml-3 mt-1 mb-1 rounded-md border border-border overflow-hidden text-xs font-mono">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-muted/50 border-b border-border text-muted-foreground">
        <Terminal className="size-3" />
        <span>Code</span>
      </div>
      <div className="px-3 py-2 bg-background/50 overflow-x-auto">
        <pre className="whitespace-pre-wrap text-foreground/80">{code}</pre>
      </div>
      {resultObj && (
        <div className="border-t border-border px-3 py-2 bg-muted/30">
          {resultObj.error ? (
            <pre className="whitespace-pre-wrap text-red-400">{resultObj.error}</pre>
          ) : (
            <pre className="whitespace-pre-wrap text-emerald-400">
              {typeof resultObj.result === "string"
                ? resultObj.result
                : JSON.stringify(resultObj.result, null, 2)}
            </pre>
          )}
          {resultObj.logs && resultObj.logs.length > 0 && (
            <pre className="whitespace-pre-wrap text-muted-foreground mt-1 pt-1 border-t border-border/50">
              {resultObj.logs.join("\n")}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
