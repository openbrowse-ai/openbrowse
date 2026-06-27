import { z } from "zod";
import { listArtifacts } from "@/lib/artifacts/registry";
import type { BrowserTool } from "../types";

const parameters = z.object({}).strict();
const outputSchema = z.object({
  artifacts: z.array(z.object({
    id: z.string(), title: z.string(), description: z.string().optional(),
    tools: z.array(z.object({ name: z.string(), mode: z.enum(["read","write"]) })),
    createdAt: z.string(), updatedAt: z.string(), lastOpenedAt: z.string().optional(),
  })),
});

export const listArtifactsTool: BrowserTool<z.infer<typeof parameters>, z.infer<typeof outputSchema>> = {
  name: "list_artifacts",
  description: "List all saved artifacts available in the user's library.",
  parameters,
  outputSchema,
  execute: async () => {
    const all = await listArtifacts();
    return {
      artifacts: all.map((a) => ({
        id: a.manifest.id,
        title: a.manifest.title,
        description: a.manifest.description,
        tools: a.manifest.tools,
        createdAt: a.sidecar.createdAt,
        updatedAt: a.sidecar.updatedAt,
        lastOpenedAt: a.sidecar.lastOpenedAt,
      })),
    };
  },
};
