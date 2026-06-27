import { Button } from "@/components/ui/button";

interface Props {
  serverName: string;
  onConnect: () => void;
  onCancel: () => void;
}

export function MissingDependency({ serverName, onConnect, onCancel }: Props) {
  return (
    <div className="max-w-md mx-auto mt-12 p-6 rounded-lg border bg-card text-sm">
      <h2 className="text-lg font-semibold mb-2">{serverName} not connected</h2>
      <p className="mb-4">
        This artifact uses the {serverName} MCP connector, which isn&apos;t connected yet.
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={onConnect}>Connect {serverName}</Button>
      </div>
    </div>
  );
}
