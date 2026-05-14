interface Tool {
  name: string;
  example: string;
  description: string;
}

const tools: Tool[] = [
  {
    name: "navigate",
    example: "navigate('https://…')",
    description: "Open URLs and switch tabs",
  },
  {
    name: "snapshot",
    example: "snapshot()",
    description: "Read the page as a structured DOM tree",
  },
  {
    name: "click",
    example: "click('@e42')",
    description: "Click any element by ref or selector",
  },
  {
    name: "typeInElement",
    example: "typeInElement('@e7', 'hello')",
    description: "Type into inputs, textareas, and contenteditables",
  },
  {
    name: "executeOnPage",
    example: "executeOnPage('…')",
    description: "Run JavaScript in the page context",
  },
  {
    name: "screenshot",
    example: "screenshot()",
    description: "Capture the visible viewport",
  },
  {
    name: "listTabs",
    example: "listTabs()",
    description: "See every open tab across spaces",
  },
  {
    name: "updateMemory",
    example: "updateMemory({ … })",
    description: "Persist context across conversations",
  },
];

export function AgentTools() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-16">
      <h2 className="text-2xl font-bold tracking-tight md:text-3xl">
        Agent tools.
      </h2>
      <p className="mt-2 max-w-2xl text-muted-foreground">
        The agent has first-class tools for reading, interacting with, and
        automating any page — plus memory and tab management.
      </p>
      <div className="mt-8 grid gap-px overflow-hidden rounded-sm border bg-border sm:grid-cols-2 lg:grid-cols-4">
        {tools.map((tool) => (
          <div key={tool.name} className="flex flex-col gap-2 bg-background p-4">
            <code className="font-mono text-xs text-foreground">
              {tool.example}
            </code>
            <p className="text-xs text-muted-foreground">{tool.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
