import type { AgentUIMessage } from "./types";

export function formatPartAsMarkdown(part: any): string | null {
  if (part.type === "text" && part.text.trim()) {
    return part.text;
  }
  
  if (
    part.type === "dynamic-tool" ||
    (typeof part.type === "string" &&
      part.type.startsWith("tool-") &&
      "toolCallId" in part &&
      ("input" in part || "args" in part))
  ) {
    const toolName =
      part.type === "dynamic-tool" ? part.toolName : part.type.slice(5);
    const p = part as Record<string, unknown>;
    const input = (p.input ?? p.args) as Record<string, unknown> | undefined;
    const hasOutput = p.state === "output-available" && "output" in p;
    const output = hasOutput ? p.output : undefined;

    if (toolName === "screenshot") {
      const inputStr = input ? "```json\n" + JSON.stringify(input, null, 2) + "\n```\n" : "";
      return `**Tool: screenshot**\n${inputStr}[Screenshot captured — base64 image data redacted]`;
    }

    if (toolName === "snapshot") {
      const inputStr = input ? "```json\n" + JSON.stringify(input, null, 2) + "\n```\n" : "";
      const hasSnapshotOut = hasOutput && output && typeof output === "object";
      
      if (hasSnapshotOut) {
        const redactedOutput = { ...output } as any;
        if ("screenshot" in redactedOutput) {
          redactedOutput.screenshot = "[base64 image data redacted]";
        }
        return `**Tool: snapshot**\n${inputStr}\n\`\`\`json\n${JSON.stringify(redactedOutput, null, 2)}\n\`\`\``;
      }
    }

    if (toolName === "skill") {
      const skillName =
        typeof input?.name === "string" ? input.name : "skill";
      const inputStr = input ? "```json\n" + JSON.stringify(input, null, 2) + "\n```\n" : "";
      return `**Tool: skill**\n${inputStr}[Skill '${skillName}' loaded into context]`;
    }

    if (toolName === "read_opfs_file") {
      const filePath =
        typeof input?.path === "string" ? input.path : "file";
      const inputStr = input ? "```json\n" + JSON.stringify(input, null, 2) + "\n```\n" : "";
      return `**Tool: read_opfs_file**\n${inputStr}[File '${filePath}' read]`;
    }

    if (toolName === "create_skill") {
      const skillName =
        typeof input?.name === "string" ? input.name : "skill";
      const inputStr = input ? "```json\n" + JSON.stringify(input, null, 2) + "\n```\n" : "";
      return `**Tool: create_skill**\n${inputStr}[Skill '${skillName}' created]`;
    }

    if (toolName === "install_skill") {
      const source =
        typeof input?.source === "string" ? input.source : "skill";
      const inputStr = input ? "```json\n" + JSON.stringify(input, null, 2) + "\n```\n" : "";
      return `**Tool: install_skill**\n${inputStr}[Skill '${source}' installed]`;
    }

    if (toolName === "todoWrite") {
      const todos = (input?.todos as Array<Record<string, unknown>>) || [];
      if (todos.length === 0) {
        return `**Plan cleared**`;
      }
      const lines = ["**Plan:**"];
      for (const todo of todos) {
        const status = todo.status === "completed" ? "[x]" : "[ ]";
        const inProgressStr = todo.status === "in_progress" ? " *(In progress)*" : "";
        lines.push(`- ${status} ${todo.content}${inProgressStr}`);
      }
      return lines.join("\n");
    }

    if (
      toolName === "executeCode" ||
      toolName === "executeOnPage" ||
      toolName === "executePython"
    ) {
      const inputStr = input ? "```json\n" + JSON.stringify(input, null, 2) + "\n```\n" : "";
      const code = typeof input?.code === "string" ? input.code : "";
      const lang = toolName === "executePython" ? "python" : "javascript";
      const lines = [
        `**Tool: ${toolName}**`,
        inputStr.trim(),
        `\`\`\`${lang}`,
        code,
        "```",
      ];
      if (hasOutput) {
        const out = output as any;
        if (out?.error) {
          lines.push(`Error: ${out.error}`);
        } else if (out?.result !== undefined && out.result !== null) {
          const outStr = typeof out.result === "string" ? out.result : JSON.stringify(out.result, null, 2);
          if (outStr.length > 50000 || (out.result && typeof out.result === "object" && "base64" in out.result)) {
            lines.push(`Result: [Large or binary output redacted]`);
          } else {
            lines.push(`Result: ${outStr}`);
          }
        }
        if (out?.stdout) {
          lines.push(`Stdout:\n${out.stdout}`);
        }
        if (out?.stderr) {
          lines.push(`Stderr:\n${out.stderr}`);
        }
        if (out?.logs && out.logs.length > 0) {
          lines.push(`Logs:\n${out.logs.join("\n")}`);
        }
      }
      return lines.filter(Boolean).join("\n");
    }

    const header = `**Tool: ${toolName}**`;
    
    let inputStr = "";
    if (input) {
      inputStr = "```json\n" + JSON.stringify(input, null, 2) + "\n```";
    }
    
    let outputStr = "";
    if (hasOutput) {
      const outStr = JSON.stringify(output, null, 2);
      if (outStr.length > 50000 || (output && typeof output === "object" && "base64" in output) || (output && typeof output === "object" && "screenshot" in output)) {
         outputStr = `\n[Large or binary output redacted]`;
      } else {
         outputStr = "\n```json\n" + outStr + "\n```";
      }
    }
    
    return [header, inputStr, outputStr].filter(Boolean).join("\n");
  }

  return null;
}

export function formatMessageAsMarkdown(message: { parts: any[] }): string {
  return message.parts
    .map(formatPartAsMarkdown)
    .filter(Boolean)
    .join("\n\n")
    .trim();
}
