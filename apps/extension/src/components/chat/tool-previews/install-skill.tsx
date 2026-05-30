import { ExternalLink, ShieldAlert } from "lucide-react";
import { registerToolPreview } from "./registry";
import {
  resolveSkillSourceDisplay,
  SkillSourceAvatar,
} from "./../skill-source-display";

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

registerToolPreview("install_skill", (args) => {
  const source = readString(args.source);

  if (!source) {
    return (
      <div className="px-3 py-2 bg-background/50 text-xs text-muted-foreground italic">
        No source provided
      </div>
    );
  }

  const info = resolveSkillSourceDisplay(source);

  return (
    <div className="px-3 py-2.5 bg-background/50 flex flex-col gap-2.5">
      {/* Identity row: avatar + skill name + "Install skill" eyebrow */}
      <div className="flex items-center gap-2.5">
        <SkillSourceAvatar avatarUrl={info.avatarUrl} />
        <div className="min-w-0 flex flex-col">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70 leading-none">
            Install skill
          </span>
          <span className="text-sm font-medium text-foreground truncate">
            {info.skillName}
          </span>
        </div>
      </div>

      {/* Source attribution */}
      {info.kind === "invalid" || !info.repoUrl ? (
        <div className="text-xs text-muted-foreground break-all">
          Source: <span className="font-mono text-foreground/80">{info.raw}</span>
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">
          Source:{" "}
          <a
            href={info.repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-foreground hover:underline break-all"
          >
            {info.ownerRepoLabel ?? info.repoUrl}
            <ExternalLink className="size-3 shrink-0" />
          </a>
        </div>
      )}

      {/* Trust note */}
      <div className="flex items-start gap-1.5 rounded bg-amber-500/10 border border-amber-500/30 px-2.5 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">
        <ShieldAlert className="size-3.5 shrink-0 mt-px" />
        <div className="leading-relaxed">
          Downloads this skill's files into OpenBrowse's local storage and makes
          it available to the agent. Only install skills from sources you trust.
        </div>
      </div>
    </div>
  );
});
