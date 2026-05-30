import { ExternalLink, FileWarning } from "lucide-react";
import type { InstalledSkill } from "@/lib/skills/types";
import {
  resolveSkillSourceDisplay,
  SkillSourceAvatar,
} from "./../skill-source-display";
import { ExpandableText } from "./expandable-text";

interface Props {
  result: unknown;
}

type InstallResult =
  | { success: true; installed: InstalledSkill[] }
  | { error: string }
  | undefined;

export function InstallSkillResult({ result }: Props) {
  const res = result as InstallResult;

  if (res && "error" in res && res.error) {
    return (
      <div className="ml-3 mt-1 mb-1 rounded-md border border-border overflow-hidden text-xs">
        <div className="px-3 py-2 bg-background/50">
          <ExpandableText
            text={res.error}
            className="font-mono text-red-400"
          />
        </div>
      </div>
    );
  }

  const installed =
    res && "success" in res && res.success ? res.installed : [];

  if (installed.length === 0) {
    return (
      <div className="ml-3 mt-1 mb-1 rounded-md border border-border overflow-hidden text-xs">
        <div className="px-3 py-2 bg-background/50 text-muted-foreground italic">
          No skills installed
        </div>
      </div>
    );
  }

  return (
    <div className="ml-3 mt-1 mb-1 rounded-md border border-border overflow-hidden text-xs">
      <div className="bg-background/50 divide-y divide-border">
        {installed.map((skill) => {
          const info = resolveSkillSourceDisplay(skill.source);
          return (
            <div key={skill.name} className="flex flex-col gap-2 px-3 py-2.5">
              <div className="flex items-start gap-2.5">
                <SkillSourceAvatar avatarUrl={info.avatarUrl} />
                <div className="min-w-0 flex flex-col gap-0.5">
                  <span className="text-sm font-medium text-foreground">
                    {skill.name}
                  </span>
                  {skill.description && (
                    <span className="text-xs text-muted-foreground leading-snug">
                      {skill.description}
                    </span>
                  )}
                  {info.repoUrl ? (
                    <a
                      href={info.repoUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground hover:underline break-all"
                    >
                      {info.ownerRepoLabel ?? info.repoUrl}
                      <ExternalLink className="size-2.5 shrink-0" />
                    </a>
                  ) : (
                    <span className="text-[11px] text-muted-foreground/70 font-mono break-all">
                      {info.raw}
                    </span>
                  )}
                </div>
              </div>

              {skill.hasScripts && (
                <div className="flex items-start gap-1.5 rounded bg-amber-500/10 border border-amber-500/30 px-2.5 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                  <FileWarning className="size-3.5 shrink-0 mt-px" />
                  <div className="leading-relaxed">
                    Contains scripts ({skill.scriptTypes.join(", ")}). OpenBrowse
                    runs in the browser and reads them as context only — it does
                    not execute them.
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
