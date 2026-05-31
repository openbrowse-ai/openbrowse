import { registerToolPreview } from "./registry";

type CloseTabsArgs =
  | { target: "group" }
  | { target: "tabs"; handles?: string[] };

export function formatCloseTabsPreview(
  input: CloseTabsArgs,
  count: number,
): string {
  if (input.target === "group") {
    const noun = count === 1 ? "tab" : "tabs";
    return `Close ${count} ${noun} in this conversation's group`;
  }
  return `Close these ${count} ${count === 1 ? "tab" : "tabs"}`;
}

registerToolPreview("closeTabs", (args) => {
  const input = args as CloseTabsArgs;
  // Group closes have no tab count in the tool args (only `tabs` closes
  // carry `handles`), so the renderer uses an "all tabs" label here rather
  // than calling formatCloseTabsPreview (which needs a count). The exact
  // count is resolved server-side; this preview is advisory.
  const label =
    input.target === "tabs"
      ? formatCloseTabsPreview(input, input.handles?.length ?? 0)
      : "Close all tabs in this conversation's group";
  return <div className="px-3 py-2 text-muted-foreground">{label}</div>;
});
