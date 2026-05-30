/**
 * Trace redaction helpers shared by the runner and the headless subagent
 * runner. Kept in its own module (rather than exported from `runner.ts`) so
 * `subagent-runner.ts` can import it without a circular dependency.
 */

/**
 * Replace a tool result's inline `imageDataUrl` with a size placeholder so
 * stored traces don't carry megabytes of base64 image data. Returns the input
 * unchanged (same reference) when there's no `imageDataUrl` field.
 */
export function redactImageData(output: unknown): unknown {
  if (
    output &&
    typeof output === "object" &&
    "imageDataUrl" in (output as Record<string, unknown>)
  ) {
    const url = (output as Record<string, unknown>).imageDataUrl;
    const size =
      typeof url === "string" ? Math.round(url.length / 1024) : 0;
    return {
      ...(output as Record<string, unknown>),
      imageDataUrl: `<image data: ${size}KB removed from trace>`,
    };
  }
  return output;
}
