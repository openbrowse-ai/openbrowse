import { z } from "zod";
import { readDiagnostics, type ArtifactDiagnostics } from "@/lib/artifacts/diagnostics";
import type { BrowserTool } from "../types";

const parameters = z
  .object({
    artifactId: z.string().describe("The id returned by create_artifact."),
    waitMs: z
      .number()
      .optional()
      .describe(
        "How long to wait (ms) for the artifact to load and report diagnostics before returning. Default 3000. The call returns early as soon as the artifact reports it rendered or an error occurs.",
      ),
  })
  .strict();

const consoleEntry = z.object({
  level: z.enum(["log", "info", "warn", "error"]),
  text: z.string(),
  ts: z.number(),
});
const errorEntry = z.object({
  message: z.string(),
  stack: z.string().optional(),
  sourceFile: z.string().optional(),
  recentConsole: z.array(z.string()).optional(),
  ts: z.number(),
});

const outputSchema = z.object({
  artifactId: z.string(),
  /** True when the artifact reported a successful initial render. */
  rendered: z
    .object({ childCount: z.number(), bodyTextSample: z.string() })
    .nullable(),
  console: z.array(consoleEntry),
  errors: z.array(errorEntry),
  startedAt: z.number().nullable(),
  waitedMs: z.number(),
  note: z.string().optional(),
});

type Input = z.infer<typeof parameters>;
type Output = z.infer<typeof outputSchema>;

const DEFAULT_WAIT_MS = 3000;
const POLL_INTERVAL_MS = 100;

/** "Done waiting" once the artifact rendered or surfaced any error. */
function isConclusive(d: ArtifactDiagnostics | null): boolean {
  return !!d && (d.rendered !== null || d.errors.length > 0);
}

/**
 * Poll the diagnostics buffer until it's conclusive (rendered or errored) or
 * the wait budget is exhausted. Extracted with injectable `read`/`sleep`/`now`
 * so it's unit-testable without real timers or chrome storage.
 */
export async function pollDiagnostics(
  artifactId: string,
  opts: {
    waitMs: number;
    read: (id: string) => Promise<ArtifactDiagnostics | null>;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    intervalMs?: number;
  },
): Promise<{ diagnostics: ArtifactDiagnostics | null; waitedMs: number }> {
  const { waitMs, read, sleep, now } = opts;
  const interval = opts.intervalMs ?? POLL_INTERVAL_MS;
  const start = now();
  let d = await read(artifactId);
  while (!isConclusive(d) && now() - start < waitMs) {
    const remaining = waitMs - (now() - start);
    await sleep(Math.min(interval, Math.max(0, remaining)));
    d = await read(artifactId);
  }
  return { diagnostics: d, waitedMs: now() - start };
}

export const readArtifactDiagnosticsTool: BrowserTool<Input, Output> = {
  name: "read_artifact_diagnostics",
  // KNOWN LIMITATION (I1): this only returns a live signal when something has
  // mounted the artifact so the shim can post ART_RENDERED. On the home surface
  // that's the auto-opened ArtifactViewerPanel (HomeApp listens for
  // artifacts:created). The side panel has no in-panel viewer and the inline
  // chat card no longer runs the artifact, so when the agent runs there this
  // returns rendered:null. The `note` below steers the user to "scroll to the
  // artifact card", which only exists on the home surface — revisit if/when the
  // side panel gains an artifact viewer.
  // NOTE (M4): not scoped by conversation — any artifact id is readable.
  // Diagnostics aren't sensitive and the agent only knows its own ids, so this
  // is acceptable; tighten if diagnostics ever carry private data.
  description:
    "After create_artifact (or update_artifact), check whether the artifact actually loaded and " +
    "rendered. Returns the artifact's forwarded console output, any uncaught errors, and a " +
    "`rendered` signal (non-null = it painted without throwing). Waits briefly for the inline " +
    "preview to run. Use this to VERIFY before telling the user it works: if `errors` is non-empty, " +
    "read them and fix with update_artifact, then call this again. If `rendered` is null after the " +
    "wait, the inline preview likely didn't mount — retry once, then ask the user to scroll to the " +
    "artifact in chat.",
  parameters,
  outputSchema,
  execute: async (input) => {
    const waitMs = input.waitMs ?? DEFAULT_WAIT_MS;
    const { diagnostics: d, waitedMs } = await pollDiagnostics(input.artifactId, {
      waitMs,
      read: readDiagnostics,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    });

    if (!d) {
      return {
        artifactId: input.artifactId,
        rendered: null,
        console: [],
        errors: [],
        startedAt: null,
        waitedMs,
        note:
          "No diagnostics recorded — the inline artifact preview may not have mounted (e.g. the chat is scrolled away, or the artifact hasn't run yet). Retry once; if still empty, ask the user to scroll to the artifact card in chat.",
      };
    }

    const rendered = d.rendered
      ? { childCount: d.rendered.childCount, bodyTextSample: d.rendered.bodyTextSample }
      : null;

    let note: string | undefined;
    if (d.errors.length > 0) {
      note = "The artifact reported errors. Read them, fix with update_artifact, then re-check.";
    } else if (!rendered) {
      note = "The artifact hasn't reported a successful render yet. It may still be loading, or it threw before painting.";
    }

    return {
      artifactId: input.artifactId,
      rendered,
      console: d.console,
      errors: d.errors,
      startedAt: d.startedAt,
      waitedMs,
      note,
    };
  },
};
