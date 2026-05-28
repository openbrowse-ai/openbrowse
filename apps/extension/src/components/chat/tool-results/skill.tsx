import { BookOpen } from "lucide-react";
import Markdown from "react-markdown";
import { ExpandableText } from "./expandable-text";

interface Props {
  args: Record<string, unknown>;
  result: unknown;
}

export function SkillResult({ args, result }: Props) {
  const name = typeof args.name === "string" ? args.name : "Skill";
  const resultObj = result as { success?: boolean; content?: string; error?: string } | undefined;

  return (
    <div className="ml-3 mt-1 mb-1 rounded-md border border-border overflow-hidden text-xs">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-muted/50 border-b border-border text-muted-foreground">
        <BookOpen className="size-3" />
        <span className="font-mono">{name}</span>
      </div>
      
      {resultObj && (
        <div className="bg-background/50 max-h-64 overflow-y-auto styled-scrollbar">
          {resultObj.error ? (
            <div className="px-3 py-2">
              {/*
                * Skill errors can be long stack traces or wrapped
                * underlying errors. Use ExpandableText to clamp at
                * 10 visual lines with an inline expand toggle —
                * matches the executeCode / executePython error
                * surfaces.
                */}
              <ExpandableText
                text={resultObj.error}
                className="font-mono text-red-400"
              />
            </div>
          ) : resultObj.content ? (
            <div className="px-3 py-2 prose prose-sm dark:prose-invert max-w-none text-foreground/80 prose-p:leading-snug prose-pre:bg-muted/50">
              <Markdown>{resultObj.content}</Markdown>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
