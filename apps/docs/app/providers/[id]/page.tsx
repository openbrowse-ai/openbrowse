import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import {
  getCatalog,
  getProvider,
  sortedModels,
  modelCount,
  adapterLabel,
} from "@/lib/models-dev";

export async function generateStaticParams() {
  const catalog = await getCatalog();
  return Object.keys(catalog).map((id) => ({ id }));
}

export async function generateMetadata(props: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await props.params;
  const provider = await getProvider(id);
  if (!provider) return {};
  return {
    title: `${provider.name} — OpenBrowse Providers`,
    description: `${provider.name} models available via the OpenBrowse model picker.`,
  };
}

function formatPrice(n: number | undefined): string | null {
  if (n === undefined) return null;
  if (n === 0) return "free";
  // models.dev costs are USD per 1M tokens. Use higher precision for
  // sub-cent prices so a fractional-cent model doesn't render as "$0.00".
  const formatted = n < 0.01 ? n.toFixed(4) : n.toFixed(2);
  return `$${formatted} / 1M`;
}

export default async function ProviderPage(props: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await props.params;
  const provider = await getProvider(id);
  if (!provider) notFound();

  const models = sortedModels(provider);

  return (
    <div className="max-w-4xl">
      <Link
        href="/providers"
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← All providers
      </Link>

      <h1 className="mt-4 text-3xl font-bold tracking-tight">{provider.name}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {modelCount(provider)} model{modelCount(provider) === 1 ? "" : "s"}
        {provider.npm && (
          <>
            {" "}· routes through the{" "}
            <span className="font-mono">{adapterLabel(provider.npm)}</span> adapter
          </>
        )}
      </p>

      <div className="mt-8 space-y-6">
        {provider.api && (
          <div>
            <h2 className="font-semibold">API endpoint</h2>
            <p className="mt-1 font-mono text-sm text-muted-foreground">
              {provider.api}
            </p>
          </div>
        )}

        {provider.env && provider.env.length > 0 && (
          <div>
            <h2 className="font-semibold">Required environment variables</h2>
            <ul className="mt-2 space-y-1 font-mono text-sm text-muted-foreground">
              {provider.env.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        )}

        {provider.doc && (
          <div>
            <a
              href={provider.doc}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium hover:underline"
            >
              Official documentation →
            </a>
          </div>
        )}

        <div>
          <h2 className="font-semibold">Models</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b text-left text-muted-foreground">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">Model</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Context</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Input</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Output</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Capabilities</th>
                </tr>
              </thead>
              <tbody>
                {models.map((m) => {
                  const caps: string[] = [];
                  if (m.tool_call) caps.push("tools");
                  if (m.reasoning) caps.push("reasoning");
                  if (m.open_weights) caps.push("open-weights");
                  if (m.modalities?.input?.includes("image")) caps.push("vision");
                  return (
                    <tr key={m.id} className="border-b last:border-0">
                      <td className="py-2 pr-4 align-top">
                        <span className="font-mono text-xs">{m.id}</span>
                        {m.status && (
                          <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs">
                            {m.status}
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-4 align-top text-muted-foreground">
                        {m.limit?.context
                          ? `${(m.limit.context / 1000).toFixed(0)}k`
                          : "—"}
                      </td>
                      <td className="py-2 pr-4 align-top text-muted-foreground">
                        {formatPrice(m.cost?.input) ?? "—"}
                      </td>
                      <td className="py-2 pr-4 align-top text-muted-foreground">
                        {formatPrice(m.cost?.output) ?? "—"}
                      </td>
                      <td className="py-2 pr-4 align-top text-muted-foreground">
                        {caps.length > 0 ? caps.join(", ") : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          Sourced from{" "}
          <a
            href="https://models.dev"
            target="_blank"
            rel="noopener noreferrer"
            className="underline-offset-4 hover:underline"
          >
            models.dev
          </a>
          . Pricing reflects the catalog at the time this page was rendered.
        </p>
      </div>
    </div>
  );
}
