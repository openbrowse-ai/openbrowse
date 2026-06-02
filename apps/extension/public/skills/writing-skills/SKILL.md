---
name: writing-skills
description: Use whenever the user asks to create, write, author, or save a skill — for example "make a skill for X", "turn this workflow into a skill", "save this as a reusable skill", or "write me a skill that…". Guides authoring a well-formed SKILL.md for OpenBrowse and installing it via the create_skill tool.
---

# `writing-skills` Skill: Authoring Skills for OpenBrowse

Use this skill whenever the user wants to capture a workflow as a reusable skill. Your job is to draft a clean, well-scoped `SKILL.md`, confirm it with the user, then persist it via the `create_skill` tool.

## 1. What a skill is in OpenBrowse

A skill is a folder under `/skills/<name>/` in the user's local workspace, containing:

- **`SKILL.md`** — required. YAML frontmatter (`name`, `description`) plus a markdown body of instructions.
- **Optional reference files** — long examples, style guides, or templates. The agent reads them on demand via `Read({ file_path: "/skills/<name>/<path>" })`.

Skills are loaded **on demand**: only each skill's `name` and `description` live in the system prompt. The body is fetched (via the `skill` tool) only when a request matches the description. Two design implications:

- The `description` is the **trigger**, not a summary. Write it as plain English: when should this skill activate?
- One skill = one clear purpose. Don't bundle unrelated workflows into a single skill — split them.

## 2. Authoring workflow

Walk through these steps with the user. Don't skip the confirmation.

1. **Clarify the trigger and scope.** Ask: when should this skill fire? What does success look like? What is explicitly out of scope?
2. **Pick a name.** Lowercase-hyphen, matches `^[a-z0-9-]+$`, ≤ 64 characters. Prefer short, specific names (`csv-to-markdown`, not `data-tools`).
3. **Draft the description.** Plain English, ≤ 1024 characters. Lead with "Use when…" or "Use whenever the user asks to…". Mention concrete trigger phrases the user might say. This is the only thing the model sees until the skill loads — make it earn its activation.
4. **Draft the body.** Imperative voice, numbered steps, concrete tool calls. Keep it tight; push long material into reference files (see §5).
5. **Show the draft to the user.** Render the full `SKILL.md` (frontmatter + body) in the chat and ask for changes before installing.
6. **Install.** Once confirmed, call `create_skill({ name, description, body })`. The user will see an approval prompt; once approved, the skill is immediately available in this and future conversations.

## 3. Frontmatter rules

```md
---
name: my-skill
description: Use whenever the user asks to convert a CSV to a markdown table.
---
```

| Field | Required | Constraint |
| --- | --- | --- |
| `name` | yes | matches `^[a-z0-9-]+$`, ≤ 64 chars |
| `description` | yes | ≤ 1024 chars; plain English; this is the trigger |

You may include extra keys (`author`, `version`, etc.) — they're stored as metadata but not used for trigger matching.

### Description: good vs. bad

- **Bad:** `"A skill for working with CSVs."` (Summary, not a trigger.)
- **Bad:** `"CSV utilities"` (Too short; agent has nothing to match against.)
- **Good:** `"Use whenever the user asks to convert a CSV to a markdown table, render a CSV inline, or summarize the columns of a CSV file."`

The good version names the **user actions** that should trigger the skill. The agent matches user intent against this string in the system prompt.

## 4. Writing a good body

- **Imperative voice.** "Parse the CSV with pandas," not "The agent should parse…".
- **Numbered steps.** Make the workflow scannable.
- **Concrete tool calls.** Reference real OpenBrowse tools (see §5). Show example invocations where useful.
- **Keep it tight.** A SKILL.md body is loaded into the conversation every time the skill activates — token cost matters. Aim for ≤ 200 lines for most skills.
- **No filler.** Skip "this skill is great because…" preambles. Get to the workflow.
- **Decision tables for variants.** When a step has multiple branches (e.g. "if the CSV has headers… otherwise…"), a small table beats prose.

## 5. OpenBrowse-runtime awareness

A skill written for OpenBrowse runs inside a browser-based agent. Reference real tools, not Linux-shell idioms.

**Common tools your skill body can reference:**

| Need | Tool |
| --- | --- |
| Open or navigate a tab | `navigate({ url })` |
| Read the current page's accessibility tree | `readPage({ tab })` or `snapshot({ tab })` |
| Run JS in the page context | `executeOnPage({ tab, code })` |
| Run JS in an isolated worker (no tab needed) | `executeCode({ code })` |
| Run Python in the user's browser (Pyodide) | `executePython({ code, allow_network? })` |
| Read / write / edit / search files in the workspace | `Read`, `Write`, `Edit`, `Glob`, `Grep`, `LS` |
| Read a file bundled with this skill | `Read({ file_path: "/skills/<name>/<path>" })` |
| Install another skill from a URL/repo | `install_skill({ source })` |

**Things that don't exist in OpenBrowse:**

- No shell, no `subprocess`, no `bash`. There is no way to spawn an OS process.
- No native binaries. `ffmpeg`, `pdftoppm`, `git`, `soffice` etc. are unavailable. Find a pure-Python or pure-JS alternative.
- Bundled scripts (`scripts/foo.sh`, `scripts/foo.py`) cannot be **executed** — they can only be **read** as reference text via `Read`. If your skill needs computation, use `executeCode` / `executePython` directly.

**Don't restate `python-env`.** If your skill writes Python, just say so — the agent will load the bundled `python-env` skill automatically for the Pyodide runtime details (pre-built packages, `micropip`, `pyfetch`, common pitfalls). Restating that material wastes tokens and goes stale.

## 6. Reference files (optional)

If your skill body would exceed ~200 lines, split long material into reference files and reference them by path. The agent reads them on demand:

```text
my-skill/
├── SKILL.md
└── references/
    └── style-guide.md
```

In your SKILL.md body, point to them like this:

> For the full style guide, read `Read({ file_path: "/skills/my-skill/references/style-guide.md" })`.

Pass them to `create_skill` via the optional `references` array:

```json
{
  "name": "my-skill",
  "description": "...",
  "body": "...",
  "references": [
    { "path": "references/style-guide.md", "content": "..." }
  ]
}
```

Most skills don't need this. Start with a single `SKILL.md` and only split when it grows.

## 7. Installing the skill

Once the user has approved the draft, call:

```json
{
  "name": "my-skill",
  "description": "Use whenever the user asks to ...",
  "body": "# my-skill\n\n1. ...\n2. ...\n"
}
```

`create_skill` requires user approval. After approval:

- The skill is written to `/skills/my-skill/` in the workspace.
- It's added to the registry with `source: "local-draft"`.
- Its `name: description` is injected into future system prompts so it can self-trigger.

If the user wants an **existing** community skill instead of a brand-new one, don't author it — point them at the `find-skills` skill (searches the [skills.sh](https://skills.sh) registry) and let it call `install_skill` directly.

## 8. Quality checklist

Before calling `create_skill`, verify the draft:

- [ ] **Single responsibility.** One clear purpose. If you find yourself writing "and also…", split it.
- [ ] **Trigger-style description.** Starts with "Use when…" or names concrete user phrases. ≤ 1024 chars.
- [ ] **Self-contained.** A fresh agent can complete the workflow from this body alone (or with the listed reference files).
- [ ] **No duplication of bundled skills.** Don't restate `python-env`; don't reimplement `find-skills`.
- [ ] **Real tool names.** Every tool referenced exists in OpenBrowse (see §5).
- [ ] **Tight.** Body ≤ ~200 lines; long material lives in references.
- [ ] **User-confirmed.** You showed the draft to the user and they approved it.

## 9. Worked example

User: "Save this as a skill — whenever I paste a CSV, convert it to a markdown table."

Draft you'd present:

````md
---
name: csv-to-markdown
description: Use whenever the user pastes CSV data and asks for it as a markdown table, or asks to "convert this CSV", "render this as a table", or "tabulate this data".
---

# `csv-to-markdown` Skill

1. Identify the CSV content in the user's message. Strip any surrounding code fences.
2. Parse it with `executePython`:
   ```python
   import pandas as pd, io
   df = pd.read_csv(io.StringIO(__input))
   df.to_markdown(index=False)
   ```
   Pass the CSV text as the tool's `input` (available as `__input`).
3. Return the markdown table inline in your reply.

Edge cases:
- If the CSV has no header row, ask the user before parsing.
- If parsing fails, show the error and the first 10 lines so the user can correct it.
````

Then call `create_skill` with that name, description, and body.
