import { connectors } from "@openbrowse/connectors";
import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Connectors",
  description: "Browse MCP connectors available in OpenBrowse.",
};

const categoryLabels: Record<string, string> = {
  "developer-tools": "Developer Tools",
  productivity: "Productivity",
  databases: "Databases",
  analytics: "Analytics",
  crm: "CRM",
};

export default function ConnectorsPage() {
  const grouped = Object.groupBy(connectors, (c) => c.category);

  return (
    <div>
      <h1 className="text-3xl font-bold tracking-tight">Connectors</h1>
      <p className="mt-2 text-muted-foreground">
        MCP integrations that extend the agent with external service access.
      </p>
      {Object.entries(grouped).map(([category, items]) => (
        <section key={category} className="mt-10">
          <h2 className="text-xl font-semibold">
            {categoryLabels[category] ?? category}
          </h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {items?.map((connector) => (
              <Link
                key={connector.id}
                href={`/connectors/${connector.id}`}
                className="rounded-lg border p-5 transition-colors hover:bg-muted/50"
              >
                <p className="font-medium">{connector.name}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {connector.description}
                </p>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
