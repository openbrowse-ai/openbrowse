import { z } from "zod";
import { loadArtifact, saveArtifact } from "@/lib/artifacts/registry";
import { validateManifest } from "@/lib/artifacts/validate";
import { applyEdits } from "@/lib/artifacts/apply-edits";
import type { ArtifactManifest } from "@/lib/artifacts/manifest";
import type { BrowserTool } from "../types";

const parameters = z.object({
  id: z.string(),
  title: z.string().optional(),
  icon: z
    .string()
    .min(1)
    .max(32)
    .optional()
    .describe("Replace the artifact's emoji icon. Omit to keep the current one."),
  description: z.string().optional(),
  edits: z
    .array(z.object({ find: z.string(), replace: z.string() }))
    .optional()
    .describe(
      "Targeted find/replace edits to the artifact's current HTML. Each `find` must occur EXACTLY ONCE in the current HTML (which is provided to you in the conversation context). Pass small, surgical snippets rather than the whole file. Omit to change only manifest fields. Do NOT target the generated `<meta name=\"openbrowse:artifact\">` tag — it is stripped and re-inlined from the manifest on save, so any edit to it is silently discarded; change manifest fields via the title/icon/tools/cdns/network params instead.",
    ),
  tools: z.array(z.object({ name: z.string(), mode: z.enum(["read","write"]) })).optional(),
  cdns: z.array(z.string()).optional(),
  network: z.array(z.string()).optional(),
}).strict();

const outputSchema = z.object({
  artifactId: z.string(), openUrl: z.string(),
  manifest: z.unknown(), warnings: z.array(z.string()),
  approvalsReset: z.boolean(),
});

type Input = z.infer<typeof parameters>;
type Output = z.infer<typeof outputSchema>;

export const updateArtifactTool: BrowserTool<Input, Output> = {
  name: "update_artifact",
  description:
    "Update an existing artifact via targeted find/replace `edits` to its HTML and/or by changing manifest fields. The current HTML is provided to you in the conversation context when editing — apply surgical edits rather than re-sending the whole file. If the security surface grows (new write tools or network hosts), user approvals are reset.",
  parameters,
  outputSchema,
  execute: async (input, ctx) => {
    if (!ctx.session?.conversationId) throw new Error("update_artifact requires a conversation context");
    const existing = await loadArtifact(input.id);
    if (!existing) throw new Error(`unknown artifact: ${input.id}`);

    const next: ArtifactManifest = {
      ...existing.manifest,
      ...(input.title !== undefined && { title: input.title }),
      ...(input.icon !== undefined && { icon: input.icon }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.tools !== undefined && { tools: input.tools }),
      ...(input.cdns !== undefined && { cdns: input.cdns }),
      ...(input.network !== undefined && { network: input.network }),
    };
    const v = validateManifest(next);
    if (!v.ok) throw new Error(`invalid manifest: ${v.errors.join("; ")}`);

    // Apply edits to the current HTML; omit `edits` for manifest-only updates.
    // NOTE: saveArtifact strips and re-inlines the <meta name="openbrowse:artifact">
    // tag from `next`, so an edit that happens to touch that tag is discarded on
    // save (manifest changes must go through the title/tools/cdns/network params).
    const html = input.edits ? applyEdits(existing.html, input.edits) : existing.html;

    const saved = await saveArtifact({ manifest: next, html, sourceConversationId: ctx.session.conversationId });
    const approvalsReset = !saved.sidecar.installedAt;
    return {
      artifactId: saved.manifest.id,
      openUrl: chrome.runtime.getURL(`artifact.html?id=${encodeURIComponent(saved.manifest.id)}`),
      manifest: saved.manifest,
      warnings: v.warnings,
      approvalsReset,
    };
  },
};
