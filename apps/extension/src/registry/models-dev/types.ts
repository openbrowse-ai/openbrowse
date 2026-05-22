/**
 * Zod schemas describing the shape of https://models.dev/api.json.
 *
 * The schemas are intentionally permissive — models.dev evolves over
 * time and we want unknown fields to be ignored rather than rejected.
 * Validation happens once at fetch/load time so consumers can trust
 * the parsed shape downstream.
 */

import { z } from "zod";

const Modality = z.enum(["text", "audio", "image", "video", "pdf"]);

const Modalities = z
  .object({
    input: z.array(Modality).optional(),
    output: z.array(Modality).optional(),
  })
  .optional();

const CostTier = z.object({
  input: z.number(),
  output: z.number(),
  cache_read: z.number().optional(),
  cache_write: z.number().optional(),
  tier: z
    .object({
      type: z.literal("context"),
      size: z.number(),
    })
    .optional(),
});

const Cost = z
  .object({
    input: z.number().optional(),
    output: z.number().optional(),
    cache_read: z.number().optional(),
    cache_write: z.number().optional(),
    reasoning: z.number().optional(),
    input_audio: z.number().optional(),
    output_audio: z.number().optional(),
    tiers: z.array(CostTier).optional(),
    context_over_200k: z
      .object({
        input: z.number(),
        output: z.number(),
        cache_read: z.number().optional(),
        cache_write: z.number().optional(),
      })
      .optional(),
  })
  .optional();

const Limit = z.object({
  context: z.number(),
  input: z.number().optional(),
  output: z.number(),
});

const ModelStatus = z.enum(["alpha", "beta", "deprecated"]);

const Interleaved = z.union([
  z.boolean(),
  z.object({
    field: z.enum(["reasoning_content", "reasoning_details"]),
  }),
]);

export const ModelsDevModelSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    family: z.string().optional(),
    attachment: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    tool_call: z.boolean().optional(),
    structured_output: z.boolean().optional(),
    temperature: z.boolean().optional(),
    knowledge: z.string().optional(),
    release_date: z.string().optional(),
    last_updated: z.string().optional(),
    open_weights: z.boolean().optional(),
    interleaved: Interleaved.optional(),
    modalities: Modalities,
    limit: Limit,
    cost: Cost,
    status: ModelStatus.optional(),
    provider: z
      .object({
        npm: z.string().optional(),
        api: z.string().optional(),
      })
      .optional(),
    experimental: z.unknown().optional(),
  })
  .passthrough();

export const ModelsDevProviderSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    npm: z.string().optional(),
    api: z.string().optional(),
    doc: z.string().optional(),
    env: z.array(z.string()).default([]),
    models: z.record(z.string(), ModelsDevModelSchema),
  })
  .passthrough();

export const ModelsDevCatalogSchema = z.record(z.string(), ModelsDevProviderSchema);

export type ModelsDevModel = z.infer<typeof ModelsDevModelSchema>;
export type ModelsDevProvider = z.infer<typeof ModelsDevProviderSchema>;
export type ModelsDevCatalog = z.infer<typeof ModelsDevCatalogSchema>;
export type ModelsDevModelStatus = z.infer<typeof ModelStatus>;
