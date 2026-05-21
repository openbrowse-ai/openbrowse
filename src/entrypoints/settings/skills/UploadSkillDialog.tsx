import { useState, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { UploadCloud } from "lucide-react";
import { parseSkillFrontmatter } from "@/lib/skills/yaml-frontmatter";
import { sendSkillMessage } from "@/lib/skills/messages";
import * as fflate from "fflate";
import { toast } from "sonner";

interface UploadSkillDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function UploadSkillDialog({ open, onOpenChange }: UploadSkillDialogProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const processFile = async (file: File) => {
    setIsUploading(true);
    try {
      if (file.name.endsWith(".md")) {
        const text = await file.text();
        const { frontmatter, body } = parseSkillFrontmatter(text);
        await sendSkillMessage({
          type: "SKILL_CREATE",
          name: frontmatter.name,
          description: frontmatter.description,
          body,
          references: [],
        });
        toast.success(`Skill "${frontmatter.name}" uploaded successfully`);
        onOpenChange(false);
      } else if (file.name.endsWith(".zip") || file.name.endsWith(".skill")) {
        const buffer = await file.arrayBuffer();
        const zip = await new Promise<fflate.Unzipped>((resolve, reject) => {
          fflate.unzip(new Uint8Array(buffer), (err, unzipped) => {
            if (err) reject(err);
            else resolve(unzipped);
          });
        });

        // Find SKILL.md (might be at root or inside a single top-level folder)
        const skillMdKey = Object.keys(zip).find((k) => k.endsWith("SKILL.md"));
        if (!skillMdKey) {
          throw new Error("No SKILL.md found in the archive");
        }

        const skillMdText = fflate.strFromU8(zip[skillMdKey]);
        const { frontmatter, body } = parseSkillFrontmatter(skillMdText);

        const prefix = skillMdKey.substring(0, skillMdKey.length - "SKILL.md".length);
        const references: { path: string; content: string }[] = [];

        for (const [key, data] of Object.entries(zip)) {
          if (!key.startsWith(prefix)) continue;
          if (key === skillMdKey) continue;
          if (key.endsWith("/")) continue; // skip directory entries
          if (data.length === 0) continue;

          const relativePath = key.substring(prefix.length);
          // Skip macOS metadata
          if (relativePath.startsWith("__MACOSX/") || relativePath.endsWith(".DS_Store")) continue;

          try {
            references.push({
              path: relativePath,
              content: fflate.strFromU8(data),
            });
          } catch {
            // Skip files that aren't valid UTF-8 (e.g. binary assets)
          }
        }

        await sendSkillMessage({
          type: "SKILL_CREATE",
          name: frontmatter.name,
          description: frontmatter.description,
          body,
          references,
        });

        toast.success(`Skill "${frontmatter.name}" uploaded successfully`);
        onOpenChange(false);
      } else {
        throw new Error("Unsupported file type. Use .md, .zip, or .skill files.");
      }
    } catch (err: any) {
      toast.error(`Upload failed: ${err.message}`);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg">Upload skill</DialogTitle>
        </DialogHeader>

        <div
          className={`mt-2 border border-dashed rounded-xl p-10 flex flex-col items-center justify-center transition-colors cursor-pointer ${
            isDragging
              ? "border-primary bg-primary/5"
              : "border-border hover:border-muted-foreground/60 hover:bg-muted/30"
          } ${isUploading ? "pointer-events-none opacity-60" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            if (e.dataTransfer.files?.[0]) processFile(e.dataTransfer.files[0]);
          }}
          onClick={() => fileInputRef.current?.click()}
        >
          <UploadCloud
            className="w-9 h-9 text-muted-foreground mb-3"
            strokeWidth={1.25}
          />
          <div className="text-sm font-medium">
            {isUploading ? "Uploading..." : "Drag and drop or click to upload"}
          </div>
          <input
            type="file"
            className="hidden"
            accept=".md,.zip,.skill"
            ref={fileInputRef}
            onChange={(e) => {
              if (e.target.files?.[0]) processFile(e.target.files[0]);
              e.target.value = "";
            }}
          />
        </div>

        <div className="mt-2 text-xs text-muted-foreground space-y-2">
          <div className="font-medium text-foreground text-sm">File requirements</div>
          <ul className="list-disc pl-5 space-y-1">
            <li>.md file must contain skill name and description formatted in YAML</li>
            <li>.zip or .skill file must include a SKILL.md file</li>
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  );
}
