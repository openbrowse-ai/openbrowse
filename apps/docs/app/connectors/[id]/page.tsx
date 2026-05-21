import { connectors, getConnector } from "@openbrowse/connectors";
import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";

export function generateStaticParams() {
  return connectors.map((c) => ({ id: c.id }));
}

export async function generateMetadata(props: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await props.params;
  const connector = getConnector(id);
  if (!connector) return {};
  return {
    title: `${connector.name} Connector`,
    description: connector.description,
  };
}

const authLabels: Record<string, string> = {
  oauth: "OAuth",
  bearer: "Bearer Token",
  "api-key": "API Key",
  none: "None",
};

export default async function ConnectorPage(props: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await props.params;
  const connector = getConnector(id);
  if (!connector) notFound();

  return (
    <div className="max-w-3xl">
      <Link
        href="/connectors"
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← All Connectors
      </Link>

      <h1 className="mt-4 text-3xl font-bold tracking-tight">
        {connector.name}
      </h1>
      <p className="mt-2 text-muted-foreground">{connector.description}</p>

      <div className="mt-8 space-y-6">
        {connector.details?.longDescription && (
          <p>{connector.details.longDescription}</p>
        )}

        <div>
          <h2 className="font-semibold">Authentication</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {authLabels[connector.auth.type]}
          </p>
        </div>

        {connector.details?.tools && connector.details.tools.length > 0 && (
          <div>
            <h2 className="font-semibold">Available Tools</h2>
            <ul className="mt-2 space-y-1">
              {connector.details.tools.map((tool) => (
                <li key={tool} className="text-sm font-mono text-muted-foreground">
                  {tool}
                </li>
              ))}
            </ul>
          </div>
        )}

        {connector.details?.developer && (
          <div>
            <h2 className="font-semibold">Developer</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {connector.details.developer.url ? (
                <a
                  href={connector.details.developer.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-foreground"
                >
                  {connector.details.developer.name}
                </a>
              ) : (
                connector.details.developer.name
              )}
            </p>
          </div>
        )}

        {connector.details?.links && connector.details.links.length > 0 && (
          <div>
            <h2 className="font-semibold">Links</h2>
            <ul className="mt-2 space-y-1">
              {connector.details.links.map((link) => (
                <li key={link.url}>
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-muted-foreground hover:text-foreground"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}

        {connector.docsUrl && (
          <div>
            <a
              href={connector.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium hover:underline"
            >
              Official Documentation →
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
