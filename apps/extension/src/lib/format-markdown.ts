import type { CompletionCheckRejectionData } from "./types";

export function formatPartAsMarkdown(part: any): string | null {
  if (part.type === "text" && part.text.trim()) {
    return part.text;
  }

  // Completion-check rejection block: render as a blockquote section so
  // the export reflects what the user saw in the UI.
  //
  // We intentionally do NOT also render the synthetic "follow-up sent
  // to agent" message here. That payload duplicates the reasoning and
  // concerns already shown above, and the only unique content (the
  // round number and the boilerplate "Continue working…" directive)
  // doesn't earn its keep — the directive is a fixed constant, and
  // round numbers are a UX leak per earlier preference.
  //
  // Force-emit and evaluator-error variants share the same render
  // path; they just don't have a "follow-up" concept anyway because
  // the loop terminates without sending anything.
  if (part.type === "data-completion-check-rejection") {
    const data = part.data as CompletionCheckRejectionData;

    if (data.reason === "evaluator-error") {
      return `> _Quality check skipped — evaluator could not complete._`;
    }

    const heading = data.forceEmittedNext
      ? "**Completion check failed**"
      : "**Completion check**";
    const lines: string[] = [`> ${heading}`, `>`];
    if (data.reasoning) lines.push(`> ${data.reasoning}`, `>`);
    for (const c of data.concerns) {
      lines.push(`> - **${c.dimension}**: ${c.detail}`);
      if (c.evidence) lines.push(`>   _Evidence:_ ${c.evidence}`);
    }
    return lines.join("\n");
  }

  // Running indicator (spinner): per user preference, exports carry
  // only rejection blocks. Drop the running indicator entirely so
  // clean turns don't add a line of noise to the export.
  if (part.type === "data-completion-check-running") {
    return null;
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

    if (toolName === "webFetch") {
      const reqUrl = typeof input?.url === "string" ? input.url : "";
      const reqFormat =
        typeof input?.format === "string" ? input.format : "markdown";
      const inputStr = input
        ? "```json\n" + JSON.stringify(input, null, 2) + "\n```\n"
        : "";
      const header = reqUrl
        ? `**Tool: webFetch** — ${reqUrl}`
        : `**Tool: webFetch**`;
      if (!hasOutput) return `${header}\n${inputStr}`.trim();

      const out = output as Record<string, unknown> | null;
      const status =
        typeof out?.status === "number" ? `HTTP ${out.status}` : "";
      const contentType =
        typeof out?.contentType === "string" && out.contentType
          ? String(out.contentType)
          : "";
      const fmt =
        typeof out?.format === "string" ? String(out.format) : reqFormat;
      const content =
        typeof out?.content === "string" ? (out.content as string) : "";
      const summarized = out?.summarized === true;
      const originalLength =
        typeof out?.originalLength === "number" ? out.originalLength : null;
      const redirected = out?.redirected === true;
      const redirectedFrom =
        typeof out?.redirectedFrom === "string"
          ? (out.redirectedFrom as string)
          : null;
      const finalUrl =
        typeof out?.url === "string" ? (out.url as string) : "";

      const meta = [
        status,
        contentType,
        `${content.length.toLocaleString()} chars`,
        summarized && originalLength != null
          ? `summarized from ${originalLength.toLocaleString()}`
          : null,
        redirected && redirectedFrom && finalUrl
          ? `redirected ${redirectedFrom} → ${finalUrl}`
          : null,
      ]
        .filter(Boolean)
        .join(" · ");

      // For markdown format we render the content directly so it stays
      // readable. For html / text / passthrough modes we wrap in a fenced
      // code block to avoid clobbering surrounding markdown.
      const body =
        fmt === "markdown"
          ? content
          : "```" +
            (fmt === "html" ? "html" : "") +
            "\n" +
            content +
            "\n```";

      return [header, inputStr.trim(), meta, "", body]
        .filter((s) => s !== null && s !== undefined)
        .join("\n");
    }

    if (toolName === "delegate") {
      const inputStr = input
        ? "```json\n" + JSON.stringify(input, null, 2) + "\n```\n"
        : "";

      const out = output as Record<string, unknown> | undefined;
      const text =
        typeof out?.finalText === "string" && out.finalText.trim().length > 0
          ? out.finalText
          : "(no output)";

      const slug =
        typeof input?.slug === "string" && input.slug.trim().length > 0
          ? input.slug.trim()
          : "subagent";
      const displayName = slug.charAt(0).toUpperCase() + slug.slice(1) + " Agent";
      const header = `**Tool: delegate** — ${displayName}`;

      return [header, inputStr.trim(), text].filter(Boolean).join("\n\n");
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
