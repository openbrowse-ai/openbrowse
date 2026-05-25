# Security Policy

OpenBrowse is a Chrome extension that handles user API keys, executes JavaScript in active tabs on behalf of an AI agent, and stores per-conversation data in the browser's OPFS. Vulnerabilities in any of these surfaces can have real impact, so we appreciate responsible disclosure.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

Instead, open a private advisory:

- [Report a vulnerability](https://github.com/openbrowse-ai/openbrowse/security/advisories/new)

If you can't use GitHub Security Advisories for some reason, email `security@openbrowse.ai`.

## What to include

To help us triage quickly, please include as much of the following as you can:

- The type of issue (e.g. credential exfiltration, sandbox escape, prompt injection leading to data loss, XSS, supply-chain).
- The affected component (side panel, content script, background service worker, offscreen document, OPFS, MCP client, models.dev registry, etc.).
- Extension version and Chrome version.
- Model and provider in use, if relevant.
- Step-by-step reproduction.
- Proof-of-concept code or recording, if available.
- Impact assessment — what could an attacker do?

## Scope

In scope:

- The published extension (Chrome Web Store and GitHub Releases).
- Code in `apps/extension`, `packages/connectors`, and the release workflow.
- The bundled `models.dev` snapshot and the refresh workflow.

Out of scope:

- Third-party MCP servers, model providers, or services we connect to (please report to those projects directly).
- Vulnerabilities in users' own machines (malware, compromised browsers, etc.).
- Issues that require an attacker to already have full control of the user's browser profile.

## Process

1. We acknowledge new advisories within 3 business days.
2. We work with you on a fix and a coordinated disclosure timeline.
3. Once a fix is released, we publish a GitHub Security Advisory crediting the reporter (unless you prefer to remain anonymous).

Thank you for helping keep OpenBrowse and its users safe.
