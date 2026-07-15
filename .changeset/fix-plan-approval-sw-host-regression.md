---
"openbrowse": patch
---

**Fix plan-approval flow under SW-host (regression): the approval card mounts again and approving a plan updates the same assistant bubble in place.**

PR #176 (MCP subagent bridge) inadvertently reverted the coordinated fixes
landed in #174, reintroducing two user-visible regressions on the
post-`proposePlan`-approval path (and every approval-gated Ask-mode tool):

1. **Approval card never appeared; the tool jumped straight to "Interrupted."**
   The SW agent host's `healLastAssistantInChatDb` ran on every run-termination
   path — including the natural pause-for-approval path — and rewrote
   `approval-requested` parts to `output-denied` in chat-db. The renderer then
   re-hydrated the in-memory message list from chat-db, so
   `findPendingPlanApproval` returned null and `PlanApprovalCard` never mounted;
   Ask-mode prompts rendered as denied before the user could act.

2. **Approving a plan left the original bubble stuck at "Drafting plan…"**
   The renderer's `CompactingChatTransport` minted a fresh `crypto.randomUUID()`
   as the assistant message id on every call — including resumes — overriding the
   AI SDK's `getResponseUIMessageId` continuation logic. The post-approval
   `output-available` chunk landed in a NEW assistant message, leaving the
   original `proposePlan` part stranded in `approval-responded` ("Drafting
   plan…") while a duplicate row appeared below it.

Fixes (re-applied from #174 onto the post-#176 tree):

- `entrypoints/background/agent-host/heal-chatdb.ts` — `healSerializedParts`
  again leaves `approval-requested` parts untouched. The SDK pauses there
  intentionally; healing it treats a legitimate resting state as an
  interruption. Renderer-side `healPendingTools` still collapses
  `approval-requested → output-denied` on the next user action, which is the
  correct point.
- `lib/agent/compacting-transport.ts` — both the fast path and the
  rejection-loop path again pass `originalMessages` to
  `result.toUIMessageStream({ ... })`, so the SDK reuses the last assistant
  message's id on resume and extends the existing bubble instead of pushing a
  duplicate. Fresh turns (last input is a user message) still get a new UUID.
- `entrypoints/background/agent-host/run.ts` — `pumpMessages` again threads the
  input transcript's trailing assistant message into
  `readUIMessageStream({ message })`, seeding the SW persister's `state.message`
  with the existing parts before resume chunks layer on top.

**Known follow-up (out of scope).** #174 also closed a reload-race in the brief
post-approval window (a `persistApprovedAssistantMessage` write in
`useAgentChat.ts`). #176's rewrite of that hook removed the helper; re-applying
it against the new architecture is deferred to a separate change. The two
regressions above — the ones users hit in Plan and Ask mode — are covered here.

**Test surface.** Restored the `heal-chatdb.test.ts` regression guards pinning
the `approval-requested`-is-not-a-heal-target contract, including the
end-to-end pending-`proposePlan` case. All agent-host and transport suites pass;
typecheck clean.
