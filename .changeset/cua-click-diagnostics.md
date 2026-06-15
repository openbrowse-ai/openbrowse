---
"openbrowse": patch
---

Fix agent clicks being silently eaten by OpenBrowse's own "is working" overlay,
and replace post-action diffs with viewport snapshots.

Trusted CDP `Input.dispatchMouseEvent` events the agent dispatched were landing
on `.ob-cua-root` — the full-viewport (`position:fixed; inset:0`) shadow-DOM
wrapper inside the `openbrowse-cua-working-host` overlay — which had implicit
`pointer-events: auto`. Because hit-testing climbs from a `pe:none` shield to
its parent, the click never reached the page element underneath. Symptoms
included FAQ accordions never expanding after `clickElement`, theme toggles
that reported success but didn't flip, and CUA subagent clicks landing on
nothing. Adding `pointer-events: none` to `.ob-cua-root` lets descendants with
explicit `pe:auto` (the shield, the Stop button) keep working as hit-test
targets while letting the agent's own dispatches pass through to the page.

Also: `clickElement` / `typeInElement` / `pressKey` now auto-attach a fresh
viewport-scoped accessibility snapshot in their response (replacing the legacy
`diff` field). The diff approach hallucinated when the prior snapshot was
viewport-scoped and the post-action capture defaulted to full-tree — the model
saw every below-fold element as `[+] added`. The new shape is strictly more
informative: the model can pick its next ref directly from the post-action
state without a follow-up `snapshot` call. The `snapshot` tool keeps its
opt-in `diff: true` mode for callers that want it.

The click ripple now matches the active space tint, doubles in size, and uses
a layered "dithered shockwave" animation (halo + dithered disc + 2 parallax
rings + center spark) so the live tab gives clearer feedback when the agent
clicks.
