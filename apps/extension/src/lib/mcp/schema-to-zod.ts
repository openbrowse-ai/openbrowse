import { z } from "zod";

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
};

function convertProperty(schema: JsonSchema): z.ZodTypeAny {
  if (schema.enum) {
    const values = schema.enum as [string, ...string[]];
    return z.enum(values);
  }

  if (schema.anyOf || schema.oneOf) {
    const variants = (schema.anyOf ?? schema.oneOf)!;
    if (variants.length === 2) {
      const nullVariant = variants.find((v) => v.type === "null");
      const otherVariant = variants.find((v) => v.type !== "null");
      if (nullVariant && otherVariant) {
        return convertProperty(otherVariant).nullable();
      }
    }
    return z.any();
  }

  switch (schema.type) {
    case "string":
      return z.string();
    case "number":
    case "integer":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(schema.items ? convertProperty(schema.items) : z.any());
    case "object":
      return convertObjectSchema(schema);
    case "null":
      return z.null();
    default:
      return z.any();
  }
}

function convertObjectSchema(schema: JsonSchema): z.ZodTypeAny {
  if (!schema.properties) {
    return z.record(z.string(), z.any());
  }

  const shape: Record<string, z.ZodTypeAny> = {};
  const required = new Set(schema.required ?? []);

  for (const [key, propSchema] of Object.entries(schema.properties)) {
    let prop = convertProperty(propSchema);
    if (propSchema.description) {
      prop = prop.describe(propSchema.description);
    }
    shape[key] = required.has(key) ? prop : prop.optional();
  }

  return z.object(shape);
}

export function jsonSchemaToZod(schema: JsonSchema): z.ZodTypeAny {
  if (!schema.type && !schema.properties) {
    return z.object({});
  }
  if (schema.type === "object" || schema.properties) {
    return convertObjectSchema(schema);
  }
  return convertProperty(schema);
}
