const providers = [
  { name: "Chrome Built-in AI (Gemini Nano)", setup: "No setup needed", local: true },
  { name: "WebLLM (Llama, Phi, etc.)", setup: "Download model in settings", local: true },
  { name: "OpenAI", setup: "API key", local: false },
  { name: "Anthropic", setup: "API key", local: false },
  { name: "Google Gemini", setup: "API key", local: false },
  { name: "OpenAI-Compatible (Groq, Together, etc.)", setup: "API key + base URL", local: false },
];

export function Providers() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-16">
      <h2 className="text-2xl font-bold tracking-tight">AI Providers</h2>
      <p className="mt-2 text-muted-foreground">
        Run locally with zero setup, or bring your own API key.
      </p>
      <div className="mt-8 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="pb-3 font-medium">Provider</th>
              <th className="pb-3 font-medium">Setup</th>
              <th className="pb-3 font-medium">Runs Locally</th>
            </tr>
          </thead>
          <tbody>
            {providers.map((p) => (
              <tr key={p.name} className="border-b">
                <td className="py-3">{p.name}</td>
                <td className="py-3 text-muted-foreground">{p.setup}</td>
                <td className="py-3">{p.local ? "Yes" : "No"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
