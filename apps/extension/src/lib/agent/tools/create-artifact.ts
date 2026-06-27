import { z } from "zod";
import { OPFS } from "@/lib/vfs/opfs";
import { saveArtifact } from "@/lib/artifacts/registry";
import { validateManifest } from "@/lib/artifacts/validate";
import { emitArtifactCreated } from "@/lib/artifacts/events";
import type { ArtifactManifest } from "@/lib/artifacts/manifest";
import type { BrowserTool } from "../types";

const ToolEntrySchema = z.object({
  name: z.string(),
  mode: z.enum(["read", "write"]),
});

const parameters = z.object({
  id: z.string().describe("Kebab-case id, e.g. 'linear-triage'."),
  title: z.string().describe("Human-readable title (1-80 chars)."),
  icon: z
    .string()
    .min(1)
    .max(32)
    .describe(
      "A single emoji used as the artifact's icon — shown as the standalone tab's favicon and as the leading glyph in artifact lists. Required. Pick one that visually represents what the artifact does (e.g. 📈 for charts, 🐛 for issue triage, 🌦 for weather).",
    ),
  description: z.string().optional().describe("What the artifact shows / does."),
  html: z.string().optional().describe(
    "The complete artifact HTML, inline. Preferred: lets you create and then immediately verify the artifact. Provide either `html` or `html_path`, not both."
  ),
  html_path: z.string().optional().describe(
    "Alternative to `html`: path within the current conversation /workspace where the HTML was written. The workspace file is consumed (removed) on success. Provide either `html` or `html_path`, not both."
  ),
  tools: z.array(ToolEntrySchema).describe(
    "List of tools the artifact may call. Names: mcp.<server>.<tool>, browser.<tool>, system.<tool>."
  ),
  cdns: z.array(z.string()).optional().describe("Allowed CDNs from the registry: 'chartjs@4.5', 'gridjs@5.0.2', 'mermaid@11.10', 'd3@7'."),
  network: z.array(z.string()).optional().describe("Hostnames the artifact may fetch from (no scheme, no path, no wildcards)."),
})
  .strict()
  .refine((v) => (v.html != null) !== (v.html_path != null), {
    message: "provide exactly one of `html` or `html_path`",
  });

const outputSchema = z.object({
  artifactId: z.string(),
  openUrl: z.string(),
  manifest: z.unknown(),
  warnings: z.array(z.string()),
});

type Input = z.infer<typeof parameters>;
type Output = z.infer<typeof outputSchema>;

function workspaceRoot(conversationId: string): string {
  return `conversations/${conversationId}/workspace`;
}

function sanitizeRel(p: string): string {
  return p.split("/").filter((s) => s !== "..").join("/");
}

export const createArtifactTool: BrowserTool<Input, Output> = {
  name: "create_artifact",
  description:
    "Save a standalone HTML+JS artifact the user can open as a tab or inline in chat. " +
    "Pass the HTML inline via `html` (preferred) or reference a /workspace file via `html_path`. " +
    "Validates the manifest, atomically writes /artifacts/<id>.html plus a sidecar, and returns an " +
    "openUrl. Before authoring an artifact, load the `authoring-artifacts` skill and follow it — " +
    "including verifying the running artifact with read_artifact_diagnostics AFTER creating it.",
  parameters,
  outputSchema,
  execute: async (input, ctx) => {
    if (!ctx.session?.conversationId) {
      throw new Error("create_artifact requires a conversation context");
    }
    const manifest: ArtifactManifest = {
      v: 1,
      id: input.id,
      title: input.title,
      icon: input.icon,
      description: input.description,
      tools: input.tools,
      cdns: input.cdns,
      network: input.network,
    };
    const v = validateManifest(manifest);
    if (!v.ok) throw new Error(`invalid manifest: ${v.errors.join("; ")}`);

    // Resolve the HTML from either the inline `html` field (preferred) or a
    // workspace file. The schema's refine() guarantees exactly one is set.
    let html: string;
    let srcPath: string | null = null;
    if (input.html != null) {
      html = input.html;
    } else {
      srcPath = `${workspaceRoot(ctx.session.conversationId)}/${sanitizeRel(input.html_path!)}`;
      if (!(await OPFS.exists(srcPath))) throw new Error(`html_path not found: ${srcPath}`);
      html = await OPFS.readFile(srcPath);
    }

    const saved = await saveArtifact({
      manifest,
      html,
      sourceConversationId: ctx.session.conversationId,
    });

    // If the HTML came from a workspace scratch file, remove it so it doesn't
    // linger in the Working folder as a confusing duplicate of the installed
    // artifact. Best-effort: a failure here must not fail the create (the
    // artifact is already saved). Inline `html` has no scratch file to clean up.
    if (srcPath) {
      try {
        await OPFS.rm(srcPath);
      } catch {
        // ignore — the artifact is saved regardless
      }
    }

    const openUrl = chrome.runtime.getURL(`artifact.html?id=${encodeURIComponent(saved.manifest.id)}`);
    // Auto-open the artifact in the in-panel viewer (where supported, e.g. the
    // home rail). This makes the artifact actually RUN immediately, so the
    // agent's follow-up read_artifact_diagnostics gets a live render/console
    // signal instead of "preview never mounted".
    emitArtifactCreated(saved.manifest.id, saved.manifest.title);
    return {
      artifactId: saved.manifest.id,
      openUrl,
      manifest: saved.manifest,
      warnings: v.warnings,
    };
  },
};
