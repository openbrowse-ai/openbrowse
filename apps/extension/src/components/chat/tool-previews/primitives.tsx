import { Terminal } from "lucide-react";

interface CodePreviewProps {
  code: string;
  label: string;
}

export function CodePreview({ code, label }: CodePreviewProps) {
  return (
    <>
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-amber-500/10 border-b border-amber-500/30 text-muted-foreground">
        <Terminal className="size-3" />
        <span>{label}</span>
      </div>
      <div className="px-3 py-2 bg-background/50 overflow-x-auto max-h-64 overflow-y-auto styled-scrollbar">
        <pre className="whitespace-pre-wrap text-foreground/80">{code}</pre>
      </div>
    </>
  );
}

interface Field {
  label: string;
  value: string;
  mono?: boolean;
}

interface FieldsPreviewProps {
  title?: string;
  fields: Field[];
}

export function FieldsPreview({ title, fields }: FieldsPreviewProps) {
  return (
    <div className="px-3 py-2 bg-background/50 space-y-2">
      {title && (
        <div className="text-xs text-muted-foreground font-medium">{title}</div>
      )}
      {fields.map((field) => (
        <div key={field.label}>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mb-0.5">
            {field.label}
          </div>
          <div className={`text-foreground/80 text-xs ${field.mono ? "font-mono whitespace-pre-wrap" : ""}`}>
            {field.value}
          </div>
        </div>
      ))}
    </div>
  );
}

interface DefaultPreviewProps {
  args: Record<string, unknown>;
}

export function DefaultPreview({ args }: DefaultPreviewProps) {
  const entries = Object.entries(args).filter(
    ([, v]) => v != null && v !== ""
  );

  if (entries.length === 0) {
    return (
      <div className="px-3 py-2 bg-background/50 text-xs text-muted-foreground italic">
        No arguments
      </div>
    );
  }

  return (
    <div className="px-3 py-2 bg-background/50 space-y-2">
      {entries.map(([key, value]) => (
        <div key={key}>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mb-0.5">
            {key}
          </div>
          <div className="text-foreground/80 text-xs font-mono whitespace-pre-wrap break-all max-h-32 overflow-y-auto styled-scrollbar">
            {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
          </div>
        </div>
      ))}
    </div>
  );
}
