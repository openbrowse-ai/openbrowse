import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ProviderDefinition, ConfigField } from "@/registry/providers/types";

interface ProviderConfigDialogProps {
  provider: ProviderDefinition;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialConfig: Record<string, string>;
  onSave: (config: Record<string, string>) => void;
}

export function ProviderConfigDialog({
  provider,
  open,
  onOpenChange,
  initialConfig,
  onSave,
}: ProviderConfigDialogProps) {
  const fields = provider.configSchema ?? [];

  const [config, setConfig] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (open) {
      const initial: Record<string, string> = {};
      for (const field of fields) {
        initial[field.key] = initialConfig[field.key] ?? field.default ?? "";
      }
      setConfig(initial);
      setTestResult(null);
    }
  }, [open, initialConfig, fields]);

  const canSave = fields
    .filter((f) => f.required)
    .every((f) => (config[f.key] ?? "").trim() !== "");

  function handleFieldChange(key: string, value: string) {
    setConfig((prev) => ({ ...prev, [key]: value }));
    setTestResult(null);
  }

  async function handleTestConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const response = await chrome.runtime.sendMessage({
        type: "TEST_CONNECTION",
        provider: provider.id,
        config,
      });
      if (response?.ok || response?.success) {
        setTestResult({ ok: true, message: response.message ?? "Connection successful" });
      } else {
        setTestResult({ ok: false, message: response?.message ?? "Connection failed" });
      }
    } catch (err: unknown) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : "Connection test failed",
      });
    } finally {
      setTesting(false);
    }
  }

  function handleSave() {
    onSave(config);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Configure {provider.name}</DialogTitle>
          <DialogDescription>{provider.description}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {fields.map((field) => (
            <FieldInput
              key={field.key}
              field={field}
              value={config[field.key] ?? ""}
              onChange={(v) => handleFieldChange(field.key, v)}
            />
          ))}

          {testResult && (
            <p className={`text-xs ${testResult.ok ? "text-green-600" : "text-red-600"}`}>
              {testResult.message}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleTestConnection} disabled={!canSave || testing}>
            {testing ? "Testing..." : "Test Connection"}
          </Button>
          <Button onClick={handleSave} disabled={!canSave}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: ConfigField;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={field.key}>
        {field.label}
        {field.required && <span className="text-red-500 ml-0.5">*</span>}
      </Label>
      {field.type === "select" && field.options ? (
        <select
          id={field.key}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <option value="">Select...</option>
          {field.options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      ) : (
        <Input
          id={field.key}
          type={field.type === "password" ? "password" : field.type === "number" ? "number" : "text"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
        />
      )}
      {field.description && (
        <p className="text-xs text-muted-foreground">{field.description}</p>
      )}
    </div>
  );
}
