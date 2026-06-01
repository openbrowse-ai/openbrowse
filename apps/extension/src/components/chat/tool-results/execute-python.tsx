import { Terminal } from "lucide-react";
import type { PythonExecuteResponse } from "@/lib/python/messages";
import { ExpandableText } from "./expandable-text";
import { HighlightedCode } from "./highlighted-code";

interface Props {
  args: Record<string, unknown>;
  result: unknown;
}

export function PythonResult({ args, result }: Props) {
  const code = typeof args.code === "string" ? args.code : "";
  const resultObj = result as PythonExecuteResponse | undefined;

  return (
    <div className="ml-3 mt-1 mb-1 rounded-md border border-border overflow-hidden text-xs font-mono">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-muted/50 border-b border-border text-muted-foreground">
        <Terminal className="size-3" />
        <span>Python</span>
      </div>
      <div className="px-3 py-2 bg-background/50 overflow-x-auto">
        <HighlightedCode code={code} lang="python" className="text-foreground/80" maxLines={10} />
      </div>
      {resultObj && (
        <div className="border-t border-border px-3 py-2 bg-muted/30">
          {resultObj.error ? (
            <div className="mb-1">
              <span className="text-red-400 font-bold block mb-1">Error ({resultObj.errorKind || "Unknown"}):</span>
              <ExpandableText text={resultObj.error} className="text-red-400" />
            </div>
          ) : resultObj.result !== undefined && resultObj.result !== null ? (
            <div className="mb-1">
              <ExpandableText 
                text={typeof resultObj.result === "string" ? resultObj.result : JSON.stringify(resultObj.result, null, 2)} 
                className="text-emerald-400" 
              />
            </div>
          ) : null}
          
          {resultObj.stdout && (
            <div className="pt-1">
              <ExpandableText text={resultObj.stdout} className="text-muted-foreground" />
            </div>
          )}
          
          {resultObj.stderr && (
            <div className="pt-1">
              <ExpandableText text={resultObj.stderr} className="text-red-400/80" />
            </div>
          )}
          
          <div className="text-[10px] text-muted-foreground/50 mt-2 pt-1 border-t border-border/20 flex justify-end">
            {(resultObj.timings?.loadMs ? `load: ${resultObj.timings.loadMs}ms | ` : "")}
            run: {resultObj.timings?.runMs || 0}ms
          </div>
        </div>
      )}
    </div>
  );
}
