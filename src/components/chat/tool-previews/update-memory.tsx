import { FieldsPreview } from "./primitives";
import { registerToolPreview } from "./registry";

registerToolPreview("updateMemory", (args) => (
  <FieldsPreview
    title={args.title as string}
    fields={[
      { label: "Content", value: (args.content as string) ?? "", mono: true },
      ...(args.description
        ? [{ label: "Description", value: args.description as string }]
        : []),
      ...(args.domain
        ? [{ label: "Domain", value: args.domain as string }]
        : []),
    ]}
  />
));
