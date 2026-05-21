import { CodePreview } from "./primitives";
import { registerToolPreview } from "./registry";

registerToolPreview("executeOnPage", (args) => (
  <CodePreview code={(args.code as string) ?? ""} label="Code to execute on page" />
));
