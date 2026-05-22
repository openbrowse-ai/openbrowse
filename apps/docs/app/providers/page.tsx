import Link from "next/link";
import type { Metadata } from "next";
import {
  getCatalog,
  sortedProviders,
  modelCount,
  totalModelCount,
} from "@/lib/models-dev";

export const metadata: Metadata = {
  title: "Providers",
  description:
    "Every AI provider OpenBrowse can talk to, sourced live from models.dev.",
};

export default async function ProvidersPage() {
  const catalog = await getCatalog();
  const providers = sortedProviders(catalog);
  const totalProviders = providers.length;
  const totalModels = totalModelCount(catalog);

  return (
    <div>
      <h1 className="text-3xl font-bold tracking-tight">Providers</h1>
      <p className="mt-2 text-muted-foreground">
        OpenBrowse is model-agnostic. The list below is sourced live from{" "}
        <a
          href="https://models.dev"
          target="_blank"
          rel="noopener noreferrer"
          className="underline-offset-4 hover:underline"
        >
          models.dev
        </a>
        — the same catalog the extension uses to populate its model picker.
      </p>

      {totalProviders > 0 && (
        <p className="mt-4 text-sm text-muted-foreground">
          {totalProviders} providers · {totalModels.toLocaleString()} models
        </p>
      )}

      {totalProviders === 0 ? (
        <div className="mt-12 rounded-lg border p-8 text-sm text-muted-foreground">
          Couldn't reach models.dev right now. The extension keeps a local
          snapshot so the model picker still works offline; this page will
          repopulate on the next ISR revalidation.
        </div>
      ) : (
        <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {providers.map((provider) => (
            <Link
              key={provider.id}
              href={`/providers/${provider.id}`}
              className="rounded-lg border p-4 transition-colors hover:bg-muted/50"
            >
              <p className="font-medium">{provider.name}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {modelCount(provider)} model
                {modelCount(provider) === 1 ? "" : "s"}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
