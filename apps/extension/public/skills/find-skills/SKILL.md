---
name: find-skills
description: Search skills.sh for agent skills matching a user's need and install them.
---

# `find-skills` Skill

This skill allows you to discover and install other agent skills from the [skills.sh](https://skills.sh) registry. Use this whenever the user asks you to "find a skill", "install a skill", or asks if there is a skill that can help them with a task.

## Workflow

1.  **Understand the Request:** Determine what kind of skill the user is looking for (e.g., "React best practices", "Web Interface Guidelines").
2.  **Search the Registry:** Make a request to the skills.sh search API to find matching skills.
3.  **Present Results:** Summarize the results for the user and ask which one they'd like to install.
4.  **Install:** Once the user selects a skill, use the `install_skill` tool to install it.

## 1. Search the Registry

The fastest path is the `executeCode` tool — it runs a script in an isolated worker (no DOM, no tab needed) and can hit the skills.sh API directly:

```javascript
// Run this using executeCode
fetch('https://skills.sh/api/search?q=YOUR_SEARCH_QUERY')
  .then(res => res.json())
  .then(data => data)
```

Replace `YOUR_SEARCH_QUERY` with the relevant terms.

If `executeCode` is unavailable for some reason, fall back to `navigate({ url: 'https://skills.sh/...' })` followed by `readPage({ tab })` against the returned handle, or `executeOnPage({ tab, code })` for a more programmatic fetch from within the page context.

## 2. Present Results

The search results will be an array of objects. Present the top 1-3 results to the user. For each result, include:
-   **Name**
-   **Description**
-   **Source** (e.g., `github:vercel-labs/agent-skills/some-skill`)

Ask the user: "Would you like me to install any of these?"

## 3. Install

When the user confirms they want to install a skill, call the `install_skill` tool, passing the `source` string from the search results.

```json
{
  "source": "github:vercel-labs/agent-skills/some-skill"
}
```

The tool will trigger an approval prompt for the user. Once approved, the skill will be installed and immediately available for you to use in the current or future conversations.
