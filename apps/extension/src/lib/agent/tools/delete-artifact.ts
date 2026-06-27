import { z } from "zod";
import { deleteArtifact, loadArtifact } from "@/lib/artifacts/registry";
import type { BrowserTool } from "../types";

const parameters = z.object({ id: z.string() }).strict();
const outputSchema = z.object({ ok: z.boolean() });

export const deleteArtifactTool: BrowserTool<z.infer<typeof parameters>, z.infer<typeof outputSchema>> = {
  name: "delete_artifact",
  description: "Delete a saved artifact (HTML, metadata, KV, cache).",
  parameters,
  outputSchema,
  approval: { required: true },
  execute: async ({ id }) => {
    if (!(await loadArtifact(id))) throw new Error(`unknown artifact: ${id}`);
    await deleteArtifact(id);
    return { ok: true };
  },
};
